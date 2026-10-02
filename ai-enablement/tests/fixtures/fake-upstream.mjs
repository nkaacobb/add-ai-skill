// A tiny OpenAI-compatible server for tests: streams a reply after `delayMs` of silence (like a model that thinks
// first) and records every request, so tests can check what a relay or the drawer sent (model, key, tools…).
//
// `respond(body, n)` scripts the answers: return { text } for a reply, or { toolCalls: [{ id, name, arguments }] }
// (`rawArguments`: argument text sent as-is, e.g. cut off; `finish`: the finish_reason, e.g. 'length')
// for tool calls (streamed in pieces, the way real servers send them). Default: the fixed `reply`.
// `cors: true` answers browser pages directly (the drawer's "custom" provider).

import http from 'node:http';

export async function startFakeUpstream({ delayMs = 0, reply = ['Hello', ' from', ' the fake model.'], models = ['fake-model', 'other-model'], respond = null, cors = false } = {}) {
  const requests = [];
  const corsHeaders = cors ? { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } : {};
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders); res.end(); return; }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.method === 'GET' && /\/models$/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
        return;
      }
      if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) { res.writeHead(404, corsHeaders); res.end('{}'); return; }
      const n = requests.filter((r) => r.method === 'POST').length;
      const plan = respond ? respond(body, n) : { text: reply };
      const chunks = [];
      if (plan.toolCalls?.length) {
        plan.toolCalls.forEach((c, index) => {
          const args = typeof c.rawArguments === 'string' ? c.rawArguments : JSON.stringify(c.arguments || {});
          const cut = Math.max(1, Math.floor(args.length / 2));
          chunks.push({ choices: [{ delta: { tool_calls: [{ index, id: c.id || `call_${index + 1}`, type: 'function', function: { name: c.name, arguments: args.slice(0, cut) } }] } }] });
          chunks.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(cut) } }] } }] });
        });
        chunks.push({ choices: [{ delta: {}, finish_reason: plan.finish || 'tool_calls' }] });
      }
      for (const text of [].concat(plan.text || [])) chunks.push({ choices: [{ delta: { content: text } }] });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', ...corsHeaders });
      let closed = false;
      res.on('close', () => { closed = true; });
      setTimeout(() => {
        if (closed) return;
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.end('data: [DONE]\n\n');
      }, delayMs);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    chats: () => requests.filter((r) => r.method === 'POST'),
    lastChat: () => [...requests].reverse().find((r) => r.method === 'POST'),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

/** Read a streamed response whole: { status, headers, text }. */
export async function readAll(res) {
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}
