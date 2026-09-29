// A tiny OpenAI-compatible server for tests: streams a fixed reply after `delayMs` of silence (like a model that
// thinks first) and records every request, so tests can check what a relay forwarded (model, key…).

import http from 'node:http';

export async function startFakeUpstream({ delayMs = 0, reply = ['Hello', ' from', ' the fake model.'], models = ['fake-model', 'other-model'] } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.method === 'GET' && /\/models$/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
        return;
      }
      if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunks = reply.map((text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      let closed = false;
      res.on('close', () => { closed = true; });
      setTimeout(() => {
        if (closed) return;
        for (const c of chunks) res.write(c);
        res.end('data: [DONE]\n\n');
      }, delayMs);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    lastChat: () => [...requests].reverse().find((r) => r.method === 'POST'),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

/** Read a streamed response whole: { status, headers, text }. */
export async function readAll(res) {
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}
