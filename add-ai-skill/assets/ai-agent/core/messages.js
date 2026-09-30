// Conversation shaping shared by the adapters. Pure: no DOM, no timers.
// Budgeting (how many turns, how much screen content) is decided by core/conversation.js; this file only makes the
// transcript structurally valid for every provider: user/assistant roles only, no empty turns, consecutive
// same-role turns merged, and the first turn always from the user (Anthropic and Gemini require that).

/**
 * Images travel beside the text, in one neutral shape shared by the adapters and the relays:
 *   { mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data: '<base64, no data: prefix>' }
 * on user messages (`images`) and on tool results (`toolTurns[].results[].images`). Anything else is dropped.
 */
export const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function cleanImages(list) {
  const out = [];
  for (const i of Array.isArray(list) ? list : []) {
    if (!i || typeof i.data !== 'string' || !IMAGE_MIME.test(String(i.mime || ''))) continue;
    if (i.data.length < 16 || !BASE64.test(i.data)) continue;
    out.push({ mime: i.mime, data: i.data });
  }
  return out;
}

export const dataUrl = (image) => `data:${image.mime};base64,${image.data}`;

/** Characters of image data in a request (allowed on top of the text size cap). */
export function imageChars(messages = [], toolTurns = []) {
  let n = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    for (const i of Array.isArray(m?.images) ? m.images : []) n += String(i?.data || '').length;
  }
  for (const t of Array.isArray(toolTurns) ? toolTurns : []) {
    for (const r of Array.isArray(t?.results) ? t.results : []) {
      for (const i of Array.isArray(r?.images) ? r.images : []) n += String(i?.data || '').length;
    }
  }
  return n;
}

export function normalizeMessages(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = String(m.content ?? '').trim();
    const images = m.role === 'user' ? cleanImages(m.images) : [];
    if (!content && !images.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = [last.content, content].filter(Boolean).join('\n\n');
      if (images.length) last.images = [...(last.images || []), ...images];
    } else {
      out.push(images.length ? { role: m.role, content, images } : { role: m.role, content });
    }
  }
  if (out.length && out[0].role === 'assistant') out.unshift({ role: 'user', content: '(The conversation continues.)' });
  return out;
}

/** Rough token estimate (~4 characters per token) for display only. */
export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 4);
