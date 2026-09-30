// The context-sync protocol: deciding, for each question, whether the model already has the current screen.
//
// Chat APIs are stateless: every request resends the conversation. So "the model has the page" means "a snapshot
// of the page, with the same fingerprint as the screen now, is inside the part of the transcript that will be
// sent". Before each question:
//
//   1. Fingerprint the screen (ContextManager.snapshot().hash).
//   2. Look for the newest snapshot inside the history window that will be sent.
//   3. Same hash  -> the model already has it: send only the question (plus a one-line "unchanged" note).
//      Otherwise  -> attach the snapshot to this question. That turn becomes the new reference point.
//
// Older snapshots are replaced by a one-line stub when the request is built, so the page is never paid for twice.
// Pure module: no DOM, no storage. The drawer owns the transcript; this file only reads it.
//
// Transcript record: { id, role: 'user'|'assistant', content, at,
//                      snapshot?: { hash, text?, pageId, pageTitle, chars, totalChars, truncated },
//                      sync?: 'attached'|'unchanged'|'off'|'empty',
//                      shots?: [{ id, thumb, width, height }]   screenshots attached to a question (ui/capture.js) }

import { shortHash } from './hash.js';

export const DEFAULT_HISTORY_MESSAGES = 20;
/** Screenshots are large: only the newest questions that carry one are sent with their image. */
export const DEFAULT_IMAGE_MESSAGES = 2;

/** Index of the first transcript entry that will still be sent, for a transcript of `length` entries. */
export function windowStart(length, historyMessages = DEFAULT_HISTORY_MESSAGES) {
  return Math.max(0, length - Math.max(2, historyMessages | 0));
}

/** Newest snapshot (with its text still available) at or after `from`. */
export function latestSnapshot(messages, from = 0) {
  for (let i = messages.length - 1; i >= from; i--) {
    const s = messages[i]?.snapshot;
    if (s && typeof s.text === 'string' && s.hash) return { index: i, snapshot: s };
  }
  return null;
}

/**
 * Decide whether the next question must carry a snapshot.
 * @param {object} o
 * @param {Array}  o.messages        transcript BEFORE the new question
 * @param {object} o.snapshot        ContextManager.snapshot() taken just now
 * @param {number} o.historyMessages how many transcript entries are sent
 * @param {boolean} o.share          the user allows sharing screen content
 * @param {boolean} o.force          the user pressed "Re-read"
 * @returns {{attach: boolean, reason: 'off'|'empty'|'forced'|'unread'|'trimmed'|'changed'|'unchanged', syncedHash: string|null}}
 */
export function planTurn({ messages = [], snapshot, historyMessages = DEFAULT_HISTORY_MESSAGES, share = true, force = false }) {
  if (!share) return { attach: false, reason: 'off', syncedHash: null };
  if (!snapshot || snapshot.empty) return { attach: false, reason: 'empty', syncedHash: null };
  const latest = latestSnapshot(messages, windowStart(messages.length + 1, historyMessages));
  const syncedHash = latest ? latest.snapshot.hash : null;
  if (force) return { attach: true, reason: 'forced', syncedHash };
  if (!latest) return { attach: true, reason: messages.some((m) => m?.snapshot) ? 'trimmed' : 'unread', syncedHash };
  if (latest.snapshot.hash !== snapshot.hash) return { attach: true, reason: 'changed', syncedHash };
  return { attach: false, reason: 'unchanged', syncedHash };
}

/**
 * The flag shown to the user.
 *   off     sharing is switched off in Settings
 *   none    the page provides no content (or it is empty)
 *   unread  the model has not seen this page in this conversation yet
 *   synced  the model has exactly what is on screen
 *   dirty   the screen changed since the model last saw it
 * `pending` is true when the next question will carry a fresh snapshot.
 */
export function contextState({ messages = [], snapshot, historyMessages = DEFAULT_HISTORY_MESSAGES, share = true, force = false }) {
  const plan = planTurn({ messages, snapshot, historyMessages, share, force });
  const base = { currentHash: snapshot?.hash || null, syncedHash: plan.syncedHash, pending: plan.attach, reason: plan.reason };
  if (plan.reason === 'off') return { ...base, state: 'off' };
  if (plan.reason === 'empty') return { ...base, state: 'none' };
  if (plan.reason === 'unchanged') return { ...base, state: 'synced' };
  if (plan.reason === 'forced') return { ...base, state: plan.syncedHash === snapshot.hash ? 'synced' : 'dirty' };
  if (plan.reason === 'changed') return { ...base, state: 'dirty' };
  return { ...base, state: 'unread' };
}

const attr = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\n/g, ' ');

/** The block the model reads. Its closing tag is neutralised inside the content so a document cannot fake it. */
export function snapshotBlock(snapshot) {
  const body = String(snapshot.text ?? '').replace(/<\/page_snapshot/gi, '<\\/page_snapshot');
  const meta = [
    `page="${attr(snapshot.pageId)}"`,
    `title="${attr(snapshot.pageTitle)}"`,
    `hash="${shortHash(snapshot.hash)}"`,
    `chars="${snapshot.totalChars ?? snapshot.chars ?? body.length}"`,
    snapshot.truncated ? 'truncated="true"' : '',
    snapshot.at ? `captured="${attr(snapshot.at)}"` : '',
  ].filter(Boolean).join(' ');
  return `<page_snapshot ${meta}>\n${body}\n</page_snapshot>`;
}

/**
 * Earlier turns that used tools are sent as text: a one-line record of the actions before the answer. (Only the
 * question being answered carries the full tool exchange, in the provider's own format — see core/tools.js.)
 * actions: [{ call: 'filter_orders(status: "open")', status: 'ok'|'error'|'declined'|'off', summary? }]
 */
export function actionsLine(actions) {
  if (!Array.isArray(actions) || !actions.length) return '';
  const word = { ok: 'done', error: 'failed', declined: 'declined by the user', off: 'tool turned off', skipped: 'skipped' };
  return `[Actions taken: ${actions.map((a) => `${a.call} → ${word[a.status] || a.status}${a.summary ? ` (${String(a.summary).slice(0, 120)})` : ''}`).join('; ')}]\n\n`;
}

export function supersededStub(snapshot) {
  return `[Page snapshot ${shortHash(snapshot.hash)} of "${snapshot.pageTitle || snapshot.pageId}" omitted here: a newer snapshot appears later in the conversation.]`;
}

/**
 * Build the provider-neutral messages for a request.
 * @param {object} o
 * @param {Array}  o.messages        transcript INCLUDING the new question as the last entry
 * @param {number} o.historyMessages how many transcript entries are sent
 * @param {string} o.viewText        current view state (cursor, selection…), attached to the new question only
 * @param {string|null} o.unchangedHash  set when the screen matches an earlier snapshot, to say so explicitly
 * @param {((shot) => ({mime, data}|null))|null} [o.imageFor]  the image of a screenshot while it is still in memory;
 *        null when the model cannot see images. Only the newest `imageMessages` questions with screenshots carry them.
 * @param {number} [o.imageMessages]
 * @returns {Array<{role: 'user'|'assistant', content: string, images?: Array<{mime, data}>}>}
 */
export function buildRequestMessages({ messages = [], historyMessages = DEFAULT_HISTORY_MESSAGES, viewText = '', unchangedHash = null, imageFor = null, imageMessages = DEFAULT_IMAGE_MESSAGES }) {
  const start = windowStart(messages.length, historyMessages);
  const windowed = messages.slice(start);
  const latest = latestSnapshot(windowed, 0);
  const lastIndex = windowed.length - 1;

  // Which questions still send their screenshots: the newest ones whose images are available.
  const imagesAt = new Map();
  for (let i = lastIndex; i >= 0 && imagesAt.size < Math.max(0, imageMessages) && imageFor; i--) {
    const m = windowed[i];
    if (m.role !== 'user' || !Array.isArray(m.shots) || !m.shots.length) continue;
    const images = m.shots.map((s) => imageFor(s)).filter(Boolean);
    if (images.length) imagesAt.set(i, images);
  }

  return windowed.map((m, i) => {
    if (m.role !== 'user') return { role: 'assistant', content: `${actionsLine(m.actions)}${String(m.content ?? '')}` };
    const parts = [];
    if (m.snapshot) {
      if (latest && latest.index === i) parts.push(snapshotBlock(m.snapshot));
      else parts.push(supersededStub(m.snapshot));
    }
    if (i === lastIndex) {
      if (!m.snapshot && unchangedHash) parts.push(`[The screen is unchanged since page snapshot ${shortHash(unchangedHash)}: it is still current.]`);
      if (viewText) parts.push(`<view_state>\n${viewText}\n</view_state>`);
    }
    const images = imagesAt.get(i);
    if (Array.isArray(m.shots) && m.shots.length) {
      const n = m.shots.length;
      parts.push(images
        ? `[${images.length === 1 ? 'A screenshot' : `${images.length} screenshots`} of the user's screen, taken when this message was sent, ${images.length === 1 ? 'is' : 'are'} attached.]`
        : `[${n === 1 ? 'A screenshot was' : `${n} screenshots were`} attached to this message; ${n === 1 ? 'it is' : 'they are'} not included any more.]`);
    }
    parts.push(String(m.content ?? ''));
    return images ? { role: 'user', content: parts.join('\n\n'), images } : { role: 'user', content: parts.join('\n\n') };
  });
}
