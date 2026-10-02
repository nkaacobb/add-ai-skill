// Attached files: what kind each one is, the text the readers get out of PDF, Word, Excel, PowerPoint, OpenDocument,
// RTF and text files, and how files and image files reach the model (blocks, stubs, the image note, the prompt).
// The documents are built in memory by tests/fixtures/documents.mjs. Needs Node 22+ (CompressionStream 'deflate-raw').

import test from 'node:test';
import assert from 'node:assert/strict';

import { readFile, fileKind, fileLabel, fileBlock, fileStub, safeName, cleanText, fileSummary, FileError, FILES_PROTOCOL, DEFAULT_MAX_FILE_CHARS } from '../assets/ai-agent/core/files.js';
import { decodeText, looksBinary, readZip, inflate } from '../assets/ai-agent/core/bytes.js';
import { excelDate, isDateFormat, scanXml } from '../assets/ai-agent/core/office.js';
import { pdfText, parseCMap, glyphText } from '../assets/ai-agent/core/pdf.js';
import { buildRequestMessages, imagesNote, hasFiles } from '../assets/ai-agent/core/conversation.js';
import { buildSystemPrompt } from '../assets/ai-agent/core/prompt.js';
import { sanitizeSettings } from '../assets/ai-agent/core/settings.js';
import * as F from './fixtures/documents.mjs';

const skip = typeof CompressionStream !== 'function' || (() => { try { new CompressionStream('deflate-raw'); return false; } catch { return true; } })()
  ? 'needs Node 21.2+ (CompressionStream deflate-raw)' : false;
const file = (bytes, name, type = '') => new File([bytes], name, { type });

/* --------------------------------------------------------------------------------------------- kinds */

test('fileKind: by extension first, then MIME type; legacy, archive and media files are named as such', () => {
  const cases = [
    ['photo.JPG', '', 'image'], ['diagram.svg', '', 'image'], ['x', 'image/webp', 'image'],
    ['report.pdf', '', 'pdf'], ['x', 'application/pdf', 'pdf'],
    ['memo.docx', '', 'docx'], ['memo.docm', '', 'docx'], ['book.xlsx', '', 'xlsx'], ['deck.pptx', '', 'pptx'],
    ['a.odt', '', 'odt'], ['a.ods', '', 'ods'], ['a.odp', '', 'odp'], ['letter.rtf', '', 'rtf'],
    ['data.csv', '', 'text'], ['app.tsx', '', 'text'], ['Dockerfile', '', 'text'], ['notes', 'text/plain', 'text'], ['x', 'application/json', 'text'],
    ['old.doc', '', 'legacy'], ['old.xls', '', 'legacy'], ['photo.heic', '', 'legacy'], ['scan.tiff', 'image/tiff', 'legacy'],
    ['bundle.zip', '', 'archive'], ['song.mp3', '', 'media'], ['clip', 'video/mp4', 'media'], ['blob.bin', '', 'unknown'],
  ];
  for (const [name, mime, kind] of cases) assert.equal(fileKind(name, mime), kind, `${name} ${mime}`);
  assert.deepEqual(['report.pdf', 'b.xlsx', 'data.csv', 'x.py', 'notes.weird'].map((n) => fileLabel(fileKind(n), n)), ['PDF', 'Excel workbook', 'CSV', 'Python', 'WEIRD file']);
});

test('safeName, cleanText and fileSummary', () => {
  assert.equal(safeName('C:\\Users\\me\\Report "final".pdf'), 'Report final.pdf');
  assert.equal(safeName('../../etc/<x>'), 'x');
  assert.equal(safeName(`${'a'.repeat(200)}.txt`).length, 111);
  assert.equal(cleanText('a\r\nb\rc\u0000d  \n\n\n\n\ne\t'), 'a\nb\ncd\n\n\ne');
  assert.equal(fileSummary({ label: 'PDF', count: 12, unit: 'pages', chars: 4000, totalChars: 34567 }), 'PDF · 12 pages · 34,567 chars');
  assert.equal(fileSummary({ label: 'CSV', chars: 4000, totalChars: 4000 }, { tokens: true }), 'CSV · ≈ 1,000 tokens');
});

/* ---------------------------------------------------------------------------------------------- text */

test('text files: UTF-8 (with or without BOM), UTF-16 with a BOM, Windows-1252; binary content is refused', async () => {
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0xc3, 0xa9])), 'hé');
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0, 0xe9, 0])), 'hé');
  assert.equal(decodeText(new Uint8Array([0xfe, 0xff, 0, 0x68, 0, 0xe9])), 'hé');
  assert.equal(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80])), 'café €', 'invalid UTF-8 reads as Windows-1252');
  assert.equal(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0])), true);
  assert.equal(looksBinary(new TextEncoder().encode('plain text\n')), false);

  const csv = await readFile(file('name,qty\r\nbolts,40\r\n', 'stock.csv', 'text/csv'));
  assert.deepEqual([csv.kind, csv.label, csv.text, csv.chars, csv.truncated], ['text', 'CSV', 'name,qty\nbolts,40', 17, false]);
  assert.match(csv.hash, /^[0-9a-f]{14}$/);
  const odd = await readFile(file('just words', 'README'));
  assert.equal(odd.kind, 'text', 'a file without a known extension is read when it is text');
  await assert.rejects(readFile(file(new Uint8Array([0, 1, 2, 3, 0, 9]), 'thing.bin')), (e) => e instanceof FileError && e.reason === 'unsupported' && /not a kind of file the agent can read/.test(e.message));
  await assert.rejects(readFile(file(new Uint8Array([0x89, 0x50, 0, 0]), 'fake.txt')), /binary content/);
});

test('limits and refusals: size, empty files, legacy formats, archives, raster images', async () => {
  await assert.rejects(readFile(file('x'.repeat(2000), 'big.txt'), { maxBytes: 1000 }), (e) => e.reason === 'too-large' && /2 KB; files up to 1000 B/.test(e.message));
  await assert.rejects(readFile(file('', 'empty.txt')), (e) => e.reason === 'empty' && /is empty/.test(e.message));
  await assert.rejects(readFile(file('x', 'old.doc')), /Old Word files \(\.doc\) cannot be read here\. Save it as \.docx or PDF/);
  await assert.rejects(readFile(file('x', 'all.zip')), /is an archive\. Unpack it/);
  await assert.rejects(readFile(file('x', 'photo.png', 'image/png')), (e) => e.reason === 'image');
  const svg = await readFile(file('<svg xmlns="http://www.w3.org/2000/svg"><text>Hi</text></svg>', 'logo.svg', 'image/svg+xml'));
  assert.equal(svg.kind, 'text', 'an SVG can be read as text (for a model that cannot see images)');
});

test('Max file content: longer text is cut and says so; totals and the hash are of the whole file', async () => {
  const body = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
  const r = await readFile(file(body, 'log.txt'), { maxChars: 1000 });
  assert.equal(r.truncated, true);
  assert.equal(r.totalChars, body.length);
  assert.ok(r.chars <= 1000 && r.chars > 800);
  assert.ok(r.text.endsWith(`…[truncated: the first 840 of ${body.length.toLocaleString('en-US')} characters are shown]`), r.text.slice(-120));
  assert.equal(DEFAULT_MAX_FILE_CHARS, 40000);
  assert.equal(sanitizeSettings({}).maxFileChars, 40000);
  assert.equal(sanitizeSettings({ maxFileChars: 10 }).maxFileChars, 40000, 'out of range falls back');
  assert.equal(sanitizeSettings({ maxFileChars: 120000 }).maxFileChars, 120000);
});

test('the app\'s readFile hook runs first: text, { text, label }, or null to use the built-in readers', async () => {
  const calls = [];
  const reader = (f, info) => { calls.push([f.name, info.kind]); return f.name.endsWith('.dwg') ? { text: 'LINE 0,0 10,10', label: 'AutoCAD drawing' } : null; };
  const dwg = await readFile(file(new Uint8Array([0, 1, 2]), 'plan.dwg'), { reader });
  assert.deepEqual([dwg.text, dwg.label], ['LINE 0,0 10,10', 'AutoCAD drawing']);
  const txt = await readFile(file('built-in', 'a.txt'), { reader });
  assert.equal(txt.text, 'built-in');
  assert.deepEqual(calls, [['plan.dwg', 'unknown'], ['a.txt', 'text']]);
  await assert.rejects(readFile(file('x', 'a.txt'), { reader: () => { throw new Error('parser crashed'); } }), /"a\.txt" could not be read: parser crashed\./);
});

/* -------------------------------------------------------------------------------------------- office */

test('ZIP: stored and deflated entries, names matched without case, inflate keeps what it read from damaged data', { skip }, async () => {
  const z = readZip(await F.zip({ 'Word/Document.xml': 'deflated text', 'b.txt': 'b' }));
  assert.deepEqual(z.names(), ['Word/Document.xml', 'b.txt']);
  assert.equal(await z.text('word/document.xml'), 'deflated text');
  assert.equal(await readZip(await F.zip({ s: 'stored' }, { deflate: false })).text('s'), 'stored');
  assert.equal(await z.text('missing'), null);
  assert.throws(() => readZip(new TextEncoder().encode('not a zip')), /not a ZIP archive/);
  const data = await F.compress(new TextEncoder().encode('x'.repeat(5000)), 'deflate');
  const cut = await inflate(data.subarray(0, data.length - 6), 'deflate');
  assert.ok(cut.length > 0 && cut.length <= 5000, 'a stream that stops early still gives its start');
  await assert.rejects(inflate(new Uint8Array([1, 2, 3, 4]), 'deflate'), /compressed data could not be read/);
  await assert.rejects(inflate(data, 'deflate', { maxBytes: 100 }), /unpacks to more than/);
});

test('Word: headings, list items, tables as rows, tabs and breaks, text boxes once, no deleted text or field codes, footnotes', { skip }, async () => {
  const r = await readFile(file(await F.docx(), 'report.docx'));
  assert.equal(r.label, 'Word document');
  assert.equal(r.text, [
    '# Quarterly report',
    '# Summary',
    'Sales rose\t12 % & costs fell.\nSecond line.',
    '- First point',
    '- Second point',
    '| Region | Total |',
    '| --- | --- |',
    '| North | 1\\|200 |',
    '',
    'Boxed note',
    '',
    'Kept words',
    '',
    '## Footnotes',
    '',
    'Source: internal figures.',
  ].join('\n'));
});

test('Excel: one CSV section per sheet, shared/inline/rich strings, dates from their number format, column gaps', { skip }, async () => {
  const r = await readFile(file(await F.xlsx(), 'sales.xlsx'));
  assert.deepEqual([r.count, r.unit], [2, 'sheets']);
  assert.equal(r.text, [
    '## Sheet: Sales',
    '',
    'Region,Date,,Note',
    'North,2023-10-01,1200.5,"Say ""hi"", ok"',
    'TRUE,,0.25',
    '',
    '## Sheet: Lookup (hidden)',
    '',
    'formula result',
  ].join('\n'));
  assert.equal(excelDate(45200), '2023-10-01');
  assert.equal(excelDate(45200.5), '2023-10-01 12:00');
  assert.equal(excelDate(59), '1900-02-28');
  assert.equal(excelDate(61), '1900-03-01', 'past the 1900 leap-year bug');
  assert.equal(excelDate(0, true), '1904-01-01');
  assert.equal(excelDate(0.75), '18:00');
  assert.deepEqual(['yyyy-mm-dd', 'h:mm AM/PM', '0.00%', '"days" 0', '[Red]0.00', 'General'].map(isDateFormat), [true, true, false, false, false, false]);
});

test('PowerPoint: slides in presentation order, with speaker notes; OpenDocument text, sheets and slides', { skip }, async () => {
  const deck = await readFile(file(await F.pptx(), 'deck.pptx'));
  assert.equal(deck.text, '## Slide 1\n\nWelcome\nAgenda for today\n\nSpeaker notes: Greet the room first.\n\n## Slide 2\n\nResults\nUp 12%');
  assert.deepEqual([deck.count, deck.unit], [2, 'slides']);

  const odt = await readFile(file(await F.odf('odt'), 'minutes.odt'));
  assert.equal(odt.text, '# Minutes\nPresent:  Ana\tBen\n- Budget approved\nNext\nmeeting Friday.');
  const ods = await readFile(file(await F.odf('ods'), 'stock.ods'));
  assert.equal(ods.text, '## Sheet: Stock\n\n| Item | Qty |\n| Bolts | 40 | 40 |');
  assert.deepEqual([ods.count, ods.unit], [1, 'sheet']);
  const odp = await readFile(file(await F.odf('odp'), 'talk.odp'));
  assert.equal(odp.text, '## Slide 1\n\nHello deck\n\n## Slide 2: Plans\n\nNext steps');
});

test('RTF: code pages per font, \\u escapes, skipped destinations, fields keep their result', async () => {
  const r = await readFile(file(F.rtf(), 'letter.rtf'));
  assert.equal(r.text, 'Café crème €5\n日本\nTab\there {braces}\nnext\nLink text');
  await assert.rejects(readFile(file('plain text', 'fake.rtf')), /not an RTF document/);
});

test('scanXml walks tags, text, CDATA and comments without a DOM', () => {
  const seen = [];
  scanXml('<a x="1>2"><b/>t &amp; u<![CDATA[<raw>]]><!-- c --></a>', { tag: (n, a, c, s) => seen.push(`${c ? '/' : ''}${n}${s ? '/' : ''}`), text: (t, cdata) => seen.push(cdata ? `cdata:${t}` : `text:${t}`) });
  assert.deepEqual(seen, ['a', 'b/', 'text:t &amp; u', 'cdata:<raw>', '/a']);
});

/* ----------------------------------------------------------------------------------------------- PDF */

test('PDF: fonts with encodings and ToUnicode maps, packed objects, forms, kerning, lines and pages', { skip }, async () => {
  const bytes = await F.samplePdf();
  const r = await pdfText(bytes);
  assert.deepEqual([r.count, r.unit, r.missing], [2, 'pages', 0]);
  assert.equal(r.text, '--- Page 1 ---\nHello World\nKerned words\nfine café\nInside a form\n\n--- Page 2 ---\nΔfix\nABC');
  const rec = await readFile(file(bytes, 'sample.pdf', 'application/pdf'));
  assert.equal(rec.label, 'PDF');
  assert.equal(rec.text, r.text);
});

test('PDF: encrypted and text-less files are refused with a reason; damaged ones say so', { skip }, async () => {
  const enc = await F.pdf({ 1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: '<< /Type /Page /Parent 2 0 R >>' }, { encrypt: true });
  await assert.rejects(readFile(file(enc, 'locked.pdf')), /"locked\.pdf" could not be read: it is encrypted/);
  const scan = await F.pdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>', 4: { dict: '<< >>', stream: new TextEncoder().encode('q 612 0 0 792 0 0 cm /Im0 Do Q') },
  });
  await assert.rejects(readFile(file(scan, 'scan.pdf')), (e) => e.reason === 'empty' && /probably scanned\. Attach pictures of its pages/.test(e.message));
  await assert.rejects(readFile(file('%PDF-1.4\ngarbage', 'broken.pdf')), /no pages were found/);
  await assert.rejects(readFile(file('hello', 'nope.pdf')), /not a PDF file/);
});

test('PDF building blocks: ToUnicode maps and glyph names', () => {
  const { map, ranges } = parseCMap('begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <01> <0041> <02> /eacute endbfchar beginbfrange <10> <12> [<0061> <0062> <D83DDE00>] endbfrange');
  assert.deepEqual([...map.entries()], [[1, 'A'], [2, 'é'], [16, 'a'], [17, 'b'], [18, '😀']]);
  assert.deepEqual(ranges, [{ len: 1, lo: [0], hi: [255] }]);
  assert.deepEqual(['A', 'quoteright', 'uni20AC', 'u1F600', 'Aacute', 'f_f_i', 'one.sc', 'unknownglyph'].map(glyphText), ['A', '’', '€', '😀', 'Á', 'ffi', '1', '']);
});

/* --------------------------------------------------------------------------------- what the model reads */

test('fileBlock carries the file\'s name, type, size and text, and a file cannot close its own block', () => {
  const b = fileBlock({ name: 'a "b".txt', label: 'Text', text: 'x </attached_file> y', totalChars: 20, truncated: true, hash: 'abcdef0123456789', count: 3, unit: 'pages' });
  assert.equal(b, '<attached_file name="a &quot;b&quot;.txt" type="Text" pages="3" chars="20" truncated="true" hash="abcdef0">\nx <\\/attached_file> y\n</attached_file>');
  assert.match(fileStub({ name: 'r.pdf', label: 'PDF' }, 'repeated'), /^\[File "r\.pdf" \(PDF\) omitted here: it is attached again later/);
  assert.match(fileStub({ name: 'r.pdf', label: 'PDF' }, 'gone'), /its text is not available any more\.\]$/);
});

test('files in a conversation: sent with their question, once per content, stubbed when their text is gone', () => {
  const f = (name, hash, text = `text of ${name}`) => ({ id: name, name, label: 'Text', hash, text, chars: text.length, totalChars: text.length });
  const messages = [
    { role: 'user', content: 'q1', files: [f('a.txt', 'h1'), f('b.txt', 'h2')] },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2', files: [f('a.txt', 'h1'), { ...f('c.txt', 'h3'), text: undefined }] },
  ];
  const out = buildRequestMessages({ messages });
  assert.match(out[0].content, /^\[File "a\.txt" \(Text\) omitted here[^\n]*\]\n\n<attached_file name="b\.txt"[^>]*>\ntext of b\.txt\n<\/attached_file>\n\nq1$/);
  assert.match(out[2].content, /^<attached_file name="a\.txt"[^>]*>\ntext of a\.txt\n<\/attached_file>\n\n\[File "c\.txt" \(Text\) was attached[^\n]*\]\n\nq2$/);
  assert.equal(hasFiles(messages), true);
  assert.equal(hasFiles(messages, 2), true, 'the newest question still has files');
  assert.equal(hasFiles([{ role: 'user', content: 'x', files: [f('a', 'h')] }, { role: 'assistant', content: 'y' }, { role: 'user', content: 'z' }, { role: 'assistant', content: 'w' }], 2), false, 'out of the window');
});

test('image files beside screenshots: named for the model, only the newest questions send them', () => {
  const PNG = { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' };
  const shot = { id: 's1' };
  const cat = { id: 'i1', name: 'cat.png', kind: 'image' };
  const dog = { id: 'i2', name: 'dog "1".png', kind: 'image' };
  assert.equal(imagesNote([shot, cat], [shot, cat]), '[Attached to this message: a screenshot of the user\'s screen (taken when this message was sent) and the image file "cat.png".]');
  assert.equal(imagesNote([cat, dog], [dog]), '[Attached to this message: the image file "dog  1 .png". The image file "cat.png" was attached to this message but is not included any more.]');
  assert.equal(imagesNote([shot], []), '[A screenshot was attached to this message; it is not included any more.]', 'screenshots alone keep the old wording');
  const out = buildRequestMessages({ messages: [{ role: 'user', content: 'what is it?', shots: [cat] }], imageFor: () => PNG });
  assert.deepEqual(out, [{ role: 'user', content: '[Attached to this message: the image file "cat.png".]\n\nwhat is it?', images: [PNG] }]);
});

test('the system prompt explains files only when the conversation has some, and images in either form', () => {
  const plain = buildSystemPrompt({ base: 'B' });
  assert.doesNotMatch(plain, /Attached files:|Images:/);
  const both = buildSystemPrompt({ base: 'B', files: true, vision: true });
  assert.ok(both.includes(FILES_PROTOCOL));
  assert.match(both, /Images: an image attached to a user message is either a screenshot[^\n]*or an image file the user attached/);
  assert.ok(both.indexOf('Attached files:') > both.indexOf('Screen content protocol') && both.indexOf('Attached files:') < both.indexOf('Images:'));
  const uploadsOnly = buildSystemPrompt({ base: 'B', vision: true, screenshots: false });
  assert.match(uploadsOnly, /Images: an image attached to a user message is an image file the user attached/);
  assert.doesNotMatch(uploadsOnly, /take_screenshot/);
});
