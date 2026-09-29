// Conversation shaping shared by the adapters. Pure: no DOM, no timers.
// Budgeting (how many turns, how much screen content) is decided by core/conversation.js; this file only makes the
// transcript structurally valid for every provider: user/assistant roles only, no empty turns, consecutive
// same-role turns merged, and the first turn always from the user (Anthropic and Gemini require that).

export function normalizeMessages(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = String(m.content ?? '').trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${content}`;
    else out.push({ role: m.role, content });
  }
  if (out.length && out[0].role === 'assistant') out.unshift({ role: 'user', content: '(The conversation continues.)' });
  return out;
}

/** Rough token estimate (~4 characters per token) for display only. */
export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 4);
