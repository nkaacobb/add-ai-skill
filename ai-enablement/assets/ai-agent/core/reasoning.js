// Separating a model's thinking from its answer. Providers that report reasoning in a dedicated field
// (reasoning_content, thinking deltas, Gemini thought parts) are handled by the adapters; this covers models that
// write it inline as <think>…</think>. It runs over the whole accumulated text on every paint, which keeps it simple
// and correct mid-stream: an unclosed block is "still thinking", and a stray closing tag (templates that put the
// opening tag in the prompt) means everything before it was reasoning.

const OPEN = /<(think|thinking)\b[^>]*>/i;
const CLOSE = /<\/(think|thinking)\s*>/i;

export function splitReasoning(raw) {
  let s = String(raw ?? '');
  const parts = [];

  const firstOpen = s.search(OPEN);
  const firstClose = s.search(CLOSE);
  if (firstClose >= 0 && (firstOpen < 0 || firstClose < firstOpen)) {
    parts.push(s.slice(0, firstClose));
    s = s.slice(s.indexOf('>', firstClose) + 1);
  }

  s = s.replace(/<(think|thinking)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (match, tag, body) => {
    parts.push(body);
    return '';
  });

  const open = s.search(OPEN);
  let thinking = false;
  if (open >= 0) {
    parts.push(s.slice(s.indexOf('>', open) + 1));
    s = s.slice(0, open);
    thinking = true;
  }

  return { reasoning: parts.map((p) => p.trim()).filter(Boolean).join('\n\n'), text: s.replace(/^\s+/, ''), thinking };
}
