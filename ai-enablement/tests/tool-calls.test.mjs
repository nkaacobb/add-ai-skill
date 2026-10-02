// Tool calls that go wrong: cut off at the max-tokens limit, unreadable arguments, text over a field's limit, and
// what a tool row shows when it is rolled down. (Found with LM Studio + qwen3.5-9b writing long note lists.)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTool, validateArgs, readArguments, parseArguments, jsonUnclosed, toolCall, wireCall, argumentsProblem,
  parseTextToolCalls, callDetail, callReport,
} from '../assets/ai-agent/core/tools.js';
import { sanitizeSettings } from '../assets/ai-agent/core/settings.js';
import { streamChat } from '../assets/ai-agent/core/client.js';
import * as openai from '../assets/ai-agent/adapters/openai-chat.js';
import * as anthropic from '../assets/ai-agent/adapters/anthropic.js';
import * as gemini from '../assets/ai-agent/adapters/gemini.js';

function sseFetch(chunks) {
  return async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); } });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

const NOTES_TOOL = normalizeTool({
  name: 'write_notes', description: 'Write notes.', run() {},
  parameters: { track: { type: 'string', required: true, maxLength: 80 }, notes: { type: 'string', required: true, maxLength: 12000 } },
});
// What LM Studio streamed when the reply ran out of tokens part-way through the notes.
const CUT = '{"track": "Concert Grand Piano", "notes": "[[0,\\"C4\\",0.5,0.8],[0.5,\\"E4\\",0.5';

test('readArguments: JSON, trailing commas, key: value lines; cut-off or garbled text is an error, not made-up values', () => {
  assert.deepEqual(readArguments('{"a": 1}'), { args: { a: 1 }, error: '' });
  assert.deepEqual(readArguments('{"a": 1, "b": [2,],}'), { args: { a: 1, b: [2] }, error: '' }, 'trailing commas forgiven');
  assert.deepEqual(readArguments('status: shipped\nlimit: 5'), { args: { status: 'shipped', limit: '5' }, error: '' }, 'small-model lines');
  assert.deepEqual(readArguments({ a: 1 }), { args: { a: 1 }, error: '' });
  assert.deepEqual(readArguments(''), { args: {}, error: '' });
  const cut = readArguments(CUT);
  assert.deepEqual(cut.args, {}, 'nothing guessed from a cut-off call (it used to give track = `"Concert Grand Piano", "notes": …`)');
  assert.match(cut.error, new RegExp(`stops before it is closed, after ${CUT.length} characters`));
  assert.equal(readArguments("{'a': 1, 'b': 2}").error, 'not valid JSON', 'one-line keys the line parser would merge');
  assert.match(readArguments([1, 2]).error, /a list/);
  assert.deepEqual(parseArguments(CUT), {}, 'parseArguments keeps its old contract: an object');
  assert.equal(jsonUnclosed('{"a": "b'), true);
  assert.equal(jsonUnclosed('{"a": [1, 2'), true);
  assert.equal(jsonUnclosed('{"a": "}"}'), false, 'braces inside strings do not count');
});

test('toolCall keeps the raw text and the diagnosis; wireCall strips them for the provider', () => {
  assert.deepEqual(toolCall('c1', 'f', '{"a":1}'), { id: 'c1', name: 'f', arguments: { a: 1 }, raw: '{"a":1}' });
  assert.deepEqual(toolCall('c1', 'f', { a: 1 }, { signature: 's' }), { id: 'c1', name: 'f', arguments: { a: 1 }, signature: 's' });
  const bad = toolCall('c2', 'write_notes', CUT);
  assert.equal(bad.raw, CUT);
  assert.match(bad.argsError, /stops before it is closed/);
  assert.deepEqual(wireCall({ ...bad, cutOff: true }), { id: 'c2', name: 'write_notes', arguments: {} });
  assert.deepEqual(wireCall({ id: 'g', name: 'f', arguments: { a: 1 }, signature: 's', raw: 'x' }), { id: 'g', name: 'f', arguments: { a: 1 }, signature: 's' });
});

test('argumentsProblem: what the user and the model are told', () => {
  const cut = argumentsProblem({ raw: CUT, argsError: 'x' }, { cutOff: true, maxTokens: 4096 });
  assert.match(cut.summary, new RegExp(`^Cut off: the reply reached Max reply tokens \\(4,096 tokens\\) after ${CUT.length} characters of arguments\\. Raise it in Settings > Agent`));
  assert.match(cut.content, /^Not run: your reply reached its length limit \(4,096 tokens\).*several smaller calls/);
  const bad = argumentsProblem({ raw: '{x', argsError: 'not valid JSON' });
  assert.equal(bad.summary, 'The arguments could not be read: not valid JSON.');
  assert.match(bad.content, /^Not run: the arguments could not be read \(not valid JSON\)\. Send them as one JSON object/);
});

test('validateArgs: text over a field limit is an error with the sizes, never cut into broken JSON', () => {
  const notes = JSON.stringify(Array.from({ length: 600 }, (_, i) => [i * 0.5, 'C#4', 0.5, 0.75]));
  const v = validateArgs(NOTES_TOOL, { track: 'seq', notes });
  assert.equal(v.ok, false);
  assert.deepEqual(v.errors, [`"notes" is ${notes.length.toLocaleString('en-US')} characters long, over its limit of 12,000: send less in one call`]);
  assert.equal(v.args.notes, undefined, 'not passed on cut');
  assert.equal(validateArgs(NOTES_TOOL, { track: 'seq', notes: [[0, 'C4', 1]] }).args.notes, '[[0,"C4",1]]', 'an array is still sent on as JSON text');
  const free = normalizeTool({ name: 'note', description: 'd', run() {}, parameters: { text: { type: 'string' } } });
  assert.match(validateArgs(free, { text: 'x'.repeat(501) }).errors[0], /over its limit of 500/, 'the 500 default applies too');
});

test('openai-chat: finish_reason "length" marks the reply truncated; the cut call keeps its raw text', async () => {
  const d = (x, finish = null) => `data: ${JSON.stringify({ choices: [{ delta: x, finish_reason: finish }] })}\n\n`;
  const fetch = sseFetch([
    d({ reasoning_content: 'Let me write the piece…' }),
    d({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'write_notes', arguments: CUT.slice(0, 40) } }] }),
    d({ tool_calls: [{ index: 0, function: { arguments: CUT.slice(40) } }] }),
    d({}, 'length'),
    'data: [DONE]\n\n',
  ]);
  const res = await openai.openaiChat.stream({ cfg: { baseUrl: 'http://x', model: 'm' }, messages: [{ role: 'user', content: 'q' }], onEvent: () => {}, fetch });
  assert.equal(res.truncated, true);
  assert.equal(res.toolCalls[0].raw, CUT);
  assert.match(res.toolCalls[0].argsError, /stops before it is closed/);
  assert.deepEqual(res.toolCalls[0].arguments, {});

  const done = sseFetch([d({ tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{}' } }] }), d({}, 'tool_calls'), 'data: [DONE]\n\n']);
  const ok = await openai.openaiChat.stream({ cfg: { baseUrl: 'http://x', model: 'm' }, messages: [{ role: 'user', content: 'q' }], onEvent: () => {}, fetch: done });
  assert.equal(ok.truncated, undefined, 'a normal end is not truncated');
  assert.equal(openai.parseFull({ choices: [{ message: { content: 'cut' }, finish_reason: 'length' }] }).truncated, true, 'non-streamed too');
});

test('anthropic stop_reason "max_tokens" and gemini finishReason "MAX_TOKENS" mark the reply truncated', async () => {
  const ev = (x) => `data: ${JSON.stringify(x)}\n\n`;
  const aFetch = sseFetch([
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'write_notes', input: {} } }),
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"track":"seq","notes":"[[0,' } }),
    ev({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4096 } }),
  ]);
  const ar = await anthropic.anthropic.stream({ cfg: { baseUrl: 'https://api.anthropic.com', model: 'm' }, messages: [{ role: 'user', content: 'q' }], onEvent: () => {}, fetch: aFetch });
  assert.equal(ar.truncated, true);
  assert.match(ar.toolCalls[0].argsError, /stops before it is closed/);
  assert.equal(anthropic.parseFull({ content: [{ type: 'text', text: 'x' }], stop_reason: 'max_tokens' }).truncated, true);

  const gFetch = sseFetch([ev({ candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] })]);
  const gr = await gemini.gemini.stream({ cfg: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gm' }, messages: [{ role: 'user', content: 'q' }], onEvent: () => {}, fetch: gFetch });
  assert.equal(gr.truncated, true);
});

test('relay: tool_call.raw is diagnosed in the browser; done.truncated comes through', async () => {
  const fetch = async () => sseFetch([
    `event: tool_call\ndata: ${JSON.stringify({ id: 'c1', name: 'write_notes', arguments: {}, raw: CUT })}\n\n`,
    'event: done\ndata: {"truncated":true}\n\n',
  ])();
  const settings = sanitizeSettings({ transport: 'relay', relayUrl: 'http://x/relay' });
  const r = await streamChat({ settings, keyFor: () => '', system: '', messages: [{ role: 'user', content: 'q' }], fetch });
  assert.equal(r.truncated, true);
  assert.equal(r.toolCalls[0].raw, CUT);
  assert.match(r.toolCalls[0].argsError, /stops before it is closed/);
});

test('text mode: an unclosed tool block becomes the cut-off call only when the reply was truncated', () => {
  const reply = 'Writing it now.\n```tool\n{"name": "write_notes", "arguments": {"track": "seq", "notes": "[[0,\\"C4\\"';
  const kept = parseTextToolCalls(reply, 't');
  assert.deepEqual(kept.calls, [], 'not truncated: left as text, as before');
  const cut = parseTextToolCalls(reply, 't', { cutOff: true });
  assert.equal(cut.text, 'Writing it now.');
  assert.equal(cut.calls.length, 1);
  assert.equal(cut.calls[0].name, 'write_notes');
  assert.match(cut.calls[0].argsError, /stops before it is closed/);
  const whole = parseTextToolCalls('```tool\n{"name": "f", "arguments": {"a": 1}}\n```', 't');
  assert.deepEqual(whole.calls, [{ id: 't1', name: 'f', arguments: { a: 1 }, raw: '{"name": "f", "arguments": {"a": 1}}' }]);
});

test('callDetail / callReport: what a rolled-down tool row shows and copies', () => {
  const ok = callDetail({ call: { arguments: { track: 'seq' }, raw: '{"track":"seq"}' }, args: { track: 'seq' }, result: 'Wrote 8 notes.' });
  assert.deepEqual(ok, { args: '{\n  "track": "seq"\n}', sent: '', problem: '', result: 'Wrote 8 notes.' }, 'sent left out when it says the same');
  const coerced = callDetail({ call: { arguments: { limit: '500', extra: 1 } }, args: { limit: 50 }, result: 'x' });
  assert.equal(coerced.sent, '{\n  "extra": 1,\n  "limit": "500"\n}', 'shown when validation changed or dropped something');
  const call = toolCall('c', 'write_notes', CUT);
  const p = argumentsProblem(call, { cutOff: true, maxTokens: 4096 });
  const bad = callDetail({ call, args: {}, problem: p.summary, result: p.content });
  assert.equal(bad.sent, CUT, 'the raw text, exactly as the model sent it');
  const report = callReport({ name: 'write_notes', title: 'Write notes', status: 'error', detail: bad });
  assert.ok(report.startsWith('Write notes · write_notes · Failed\n\nProblem: Cut off:'), report);
  assert.ok(report.includes(`Arguments as the model sent them (${CUT.length} characters):\n${CUT}`), report);
  assert.ok(report.includes('Returned to the model:\nNot run: your reply reached its length limit'), report);
});
