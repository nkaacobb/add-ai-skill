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
//                      shots?: [{ id, thumb, width, height, name?, kind? }]   images attached to a question: screenshots
//                              (ui/capture.js), or image files the user attached (kind 'image', with their name)
//                      files?: [FileRecord]   documents the user attached, with their text (core/files.js) }

import { shortHash } from './hash.js';
import { fileBlock, fileStub } from './files.js';

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

const isImageFile = (s) => s.kind === 'image' || !!s.name;
const quoted = (name) => `"${String(name || 'image').replace(/["\n\r]/g, ' ').slice(0, 120)}"`;
const listText = (items) => (items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** "a screenshot of the user's screen (…) and the image file "x.png"": what a set of attached images is. */
function describeImages(shots) {
  const screens = shots.filter((s) => !isImageFile(s)).length;
  const items = [];
  if (screens) items.push(`${screens === 1 ? 'a screenshot' : `${screens} screenshots`} of the user's screen (taken when this message was sent)`);
  for (const s of shots.filter(isImageFile)) items.push(`the image file ${quoted(s.name)}`);
  return listText(items);
}

/** The line that tells the model which images a question carried (`sent`: those still included). */
export function imagesNote(shots, sent) {
  const n = shots.length;
  if (!shots.some(isImageFile)) {
    // Screenshots only: the wording of earlier versions.
    return sent.length
      ? `[${sent.length === 1 ? 'A screenshot' : `${sent.length} screenshots`} of the user's screen, taken when this message was sent, ${sent.length === 1 ? 'is' : 'are'} attached.]`
      : `[${n === 1 ? 'A screenshot was' : `${n} screenshots were`} attached to this message; ${n === 1 ? 'it is' : 'they are'} not included any more.]`;
  }
  const gone = shots.filter((s) => !sent.includes(s));
  const parts = [];
  if (sent.length) parts.push(`Attached to this message: ${describeImages(sent)}.`);
  if (gone.length) {
    const what = describeImages(gone);
    parts.push(`${what[0].toUpperCase()}${what.slice(1)} ${gone.length === 1 ? 'was' : 'were'} attached to this message but ${gone.length === 1 ? 'is' : 'are'} not included any more.`);
  }
  return `[${parts.join(' ')}]`;
}

/** Does the part of the transcript that will be sent carry attached files? (The system prompt then explains them.) */
export function hasFiles(messages = [], historyMessages = DEFAULT_HISTORY_MESSAGES) {
  return messages.slice(windowStart(messages.length, historyMessages)).some((m) => m?.role === 'user' && Array.isArray(m.files) && m.files.length > 0);
}

/**
 * Build the provider-neutral messages for a request.
 * @param {object} o
 * @param {Array}  o.messages        transcript INCLUDING the new question as the last entry
 * @param {number} o.historyMessages how many transcript entries are sent
 * @param {string} o.viewText        current view state (cursor, selection…), attached to the new question only
 * @param {string|null} o.unchangedHash  set when the screen matches an earlier snapshot, to say so explicitly
 * @param {((shot) => ({mime, data}|null))|null} [o.imageFor]  the image of a screenshot (or attached image file) while
 *        it is still in memory; null when the model cannot see images. Only the newest `imageMessages` questions with
 *        images carry them. Attached files' text goes with its question while that question is in the window; a file
 *        attached again later (same content) is sent with the later question only.
 * @param {number} [o.imageMessages]
 * @returns {Array<{role: 'user'|'assistant', content: string, images?: Array<{mime, data}>}>}
 */
export function buildRequestMessages({ messages = [], historyMessages = DEFAULT_HISTORY_MESSAGES, viewText = '', unchangedHash = null, imageFor = null, imageMessages = DEFAULT_IMAGE_MESSAGES }) {
  const start = windowStart(messages.length, historyMessages);
  const windowed = messages.slice(start);
  const latest = latestSnapshot(windowed, 0);
  const lastIndex = windowed.length - 1;

  // Which questions still send their images: the newest ones whose images are available.
  const imagesAt = new Map();
  for (let i = lastIndex; i >= 0 && imagesAt.size < Math.max(0, imageMessages) && imageFor; i--) {
    const m = windowed[i];
    if (m.role !== 'user' || !Array.isArray(m.shots) || !m.shots.length) continue;
    const sent = m.shots.map((shot) => ({ shot, image: imageFor(shot) })).filter((x) => x.image);
    if (sent.length) imagesAt.set(i, sent);
  }
  // A file attached more than once (same content) is sent with its newest question only.
  const lastFileAt = new Map();
  windowed.forEach((m, i) => {
    if (m.role === 'user' && Array.isArray(m.files)) for (const f of m.files) if (f?.hash) lastFileAt.set(f.hash, i);
  });

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
    for (const f of Array.isArray(m.files) ? m.files : []) {
      if (!f) continue;
      if (typeof f.text !== 'string') parts.push(fileStub(f, 'gone'));
      else if (f.hash && lastFileAt.get(f.hash) !== i) parts.push(fileStub(f, 'repeated'));
      else parts.push(fileBlock(f));
    }
    const sent = imagesAt.get(i) || [];
    if (Array.isArray(m.shots) && m.shots.length) parts.push(imagesNote(m.shots, sent.map((x) => x.shot)));
    parts.push(String(m.content ?? ''));
    const images = sent.map((x) => x.image);
    return images.length ? { role: 'user', content: parts.join('\n\n'), images } : { role: 'user', content: parts.join('\n\n') };
  });
}
