// Small but realistic documents for the attachment tests, built in memory: ZIP containers (stored or deflated, with
// CRCs) holding the XML that Word, Excel, PowerPoint and LibreOffice write, an RTF with code pages, and PDFs with the
// structures real generators use (WinAnsi + Differences, Type0/Identity-H with a ToUnicode map, Flate streams, an
// object stream, a form XObject, TJ kerning). Node 22+ (CompressionStream 'deflate-raw').

const enc = new TextEncoder();
const bytesOf = (v) => (typeof v === 'string' ? enc.encode(v) : v);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function compress(data, format) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A ZIP archive of { name: text | bytes }. `deflate` compresses every entry (Office does). */
export async function zip(entries, { deflate = true } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const data = bytesOf(value);
    const nameBytes = enc.encode(name);
    const body = deflate ? await compress(data, 'deflate-raw') : data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, deflate ? 8 : 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, deflate ? 8 : 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return new Uint8Array(await new Blob([...locals, ...centrals, end]).arrayBuffer());
}

const RELS = (rels) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('')}</Relationships>`;

/** A Word document: a title, a heading, a list, a table, a text box Word stores twice, a tab, and a footnote. */
export function docx() {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
  const p = (text, style = '', extra = '') => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
${p('Quarterly report', 'Title')}
${p('Summary', 'Heading1')}
<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Sales rose</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">12 % &amp; costs fell.</w:t></w:r><w:r><w:br/><w:t>Second line.</w:t></w:r></w:p>
${p('First point', 'ListParagraph', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')}
${p('Second point', 'ListParagraph', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')}
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Total</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1|200</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent>${p('Boxed note')}</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>${p('Boxed note')}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>
<w:p><w:r><w:delText>deleted words</w:delText></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:t>Kept words</w:t></w:r></w:p>
</w:body></w:document>`;
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': RELS([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/document.xml': document,
    'word/footnotes.xml': `<?xml version="1.0"?><w:footnotes ${W}><w:footnote w:id="0"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1">${p('Source: internal figures.')}</w:footnote></w:footnotes>`,
  });
}

/** An Excel workbook: shared and inline strings, numbers, a boolean, a date, a gap between columns, a hidden sheet. */
export function xlsx() {
  const sheet = (rows) => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  return zip({
    '_rels/.rels': RELS([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Lookup" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': RELS([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'worksheet', '/xl/worksheets/sheet2.xml'], ['rId3', 'sharedStrings', 'sharedStrings.xml'], ['rId4', 'styles', 'styles.xml']]),
    'xl/sharedStrings.xml': '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Region</t></si><si><t>Date</t></si><si><r><t>Nor</t></r><r><t>th</t></r><rPh><t>ignored</t></rPh></si><si><t>Say "hi", ok</t></si></sst>',
    'xl/styles.xml': '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="10"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': sheet(`<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Note</t></is></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>45200</v></c><c r="C2"><v>1200.5</v></c><c r="D2" t="s"><v>3</v></c></row>
<row r="3"><c r="A3" t="b"><v>1</v></c><c r="C3" s="2"><v>0.25</v></c></row>`),
    'xl/worksheets/sheet2.xml': sheet('<row r="1"><c r="A1" t="str"><v>formula result</v></c></row>'),
  });
}

/** A PowerPoint deck whose presentation order differs from its file names, with speaker notes. */
export function pptx() {
  const slide = (texts) => `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${texts.map((t) => `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`).join('')}</p:spTree></p:cSld></p:sld>`;
  return zip({
    '_rels/.rels': RELS([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': RELS([['rId2', 'slide', 'slides/slide1.xml'], ['rId3', 'slide', 'slides/slide2.xml']]),
    'ppt/slides/slide1.xml': slide(['Results', 'Up 12%']),
    'ppt/slides/slide2.xml': slide(['Welcome', 'Agenda for today']),
    'ppt/slides/_rels/slide2.xml.rels': RELS([['rId1', 'notesSlide', '../notesSlides/notesSlide1.xml']]),
    'ppt/notesSlides/notesSlide1.xml': slide(['Greet the room first.', '1']),
  });
}

/** OpenDocument text / spreadsheet / presentation content. */
export function odf(kind) {
  const ns = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"';
  const bodies = {
    odt: '<office:text><text:h text:outline-level="1">Minutes</text:h><text:p>Present:<text:s text:c="2"/>Ana<text:tab/>Ben</text:p><text:list><text:list-item><text:p>Budget approved</text:p></text:list-item></text:list><text:p>Next<text:line-break/>meeting<office:annotation><text:p>hidden comment</text:p></office:annotation> Friday.</text:p></office:text>',
    ods: '<office:spreadsheet><table:table table:name="Stock"><table:table-row><table:table-cell><text:p>Item</text:p></table:table-cell><table:table-cell><text:p>Qty</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>Bolts</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"><text:p>40</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1000"/></table:table-row></table:table></office:spreadsheet>',
    odp: '<office:presentation><draw:page draw:name="page1"><draw:frame><draw:text-box><text:p>Hello deck</text:p></draw:text-box></draw:frame></draw:page><draw:page draw:name="Plans"><draw:frame><draw:text-box><text:p>Next steps</text:p></draw:text-box></draw:frame></draw:page></office:presentation>',
  };
  return zip({
    mimetype: `application/vnd.oasis.opendocument.${{ odt: 'text', ods: 'spreadsheet', odp: 'presentation' }[kind]}`,
    'content.xml': `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ns}><office:body>${bodies[kind]}</office:body></office:document-content>`,
  }, { deflate: false });
}

/** An RTF with a font table (a Japanese font), Windows-1252 accents, \u escapes and destinations to skip. */
export function rtf() {
  // "日本" in Shift-JIS: 93 fa 96 7b
  return enc.encode(String.raw`{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0\fswiss\fcharset0 Arial;}{\f1\fnil\fcharset128 MS Gothic;}}{\colortbl;\red0\green0\blue0;}{\*\generator Test;}{\info{\title Secret title}}
\f0\fs22 Caf\'e9 cr\'e8me \u8364?5\par
{\f1 \'93\'fa\'96\'7b}\par
Tab\tab here \{braces\}\line next\par
{\field{\*\fldinst HYPERLINK "http://x"}{\fldrslt Link text}}\par
}`);
}

/* ------------------------------------------------------------------------------------------------- PDF */

const latin = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));
const join = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/**
 * Write a PDF from objects { num: string body | { dict, stream: bytes } }. With `packed`, those object numbers go
 * into one object stream (PDF 1.5).
 */
export async function pdf(objects, { root = 1, packed = [], encrypt = false } = {}) {
  const parts = [latin('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
  let size = parts[0].length;
  const offsets = {};
  const add = (num, bytes) => { offsets[num] = size; parts.push(bytes); size += bytes.length; };
  const entries = Object.entries(objects).map(([n, v]) => [Number(n), v]);
  const max = Math.max(...entries.map(([n]) => n));
  if (packed.length) {
    let head = '';
    let body = '';
    for (const n of packed) { head += `${n} ${body.length} `; body += `${objects[n]}\n`; }
    const data = await compress(latin(head + body), 'deflate');
    add(max + 1, join([latin(`${max + 1} 0 obj\n<< /Type /ObjStm /N ${packed.length} /First ${head.length} /Filter /FlateDecode /Length ${data.length} >>\nstream\n`), data, latin('\nendstream\nendobj\n')]));
  }
  for (const [n, v] of entries) {
    if (packed.includes(n)) continue;
    if (typeof v === 'string') add(n, latin(`${n} 0 obj\n${v}\nendobj\n`));
    else add(n, join([latin(`${n} 0 obj\n${v.dict.replace('>>', ` /Length ${v.stream.length} >>`)}\nstream\n`), v.stream, latin('\nendstream\nendobj\n')]));
  }
  const xref = size;
  let table = `xref\n0 ${max + 2}\n0000000000 65535 f \n`;
  for (let n = 1; n <= max + 1; n++) table += offsets[n] !== undefined ? `${String(offsets[n]).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  parts.push(latin(`${table}trailer\n<< /Size ${max + 2} /Root ${root} 0 R${encrypt ? ' /Encrypt 99 0 R' : ''} >>\nstartxref\n${xref}\n%%EOF\n`));
  return join(parts);
}

/**
 * Two pages: page 1 in Helvetica (WinAnsi + Differences: code 0x80 is "fi", code 0x81 "eacute"), with TJ kerning
 * gaps and a form XObject; page 2 in a Type0/Identity-H font with a ToUnicode map (two-byte codes, a ligature, a
 * bfrange). The fonts and the second page live in an object stream.
 */
export async function samplePdf() {
  const content1 = 'BT /F1 12 Tf 72 720 Td (Hello) Tj ( World) Tj 0 -16 Td [(Kern)-80(ed)-400(words)] TJ 0 -16 Td (\\200ne caf\\201) Tj ET q 1 0 0 1 72 600 cm /Fm1 Do Q';
  const form = 'BT /F1 10 Tf 0 0 Td (Inside a form) Tj ET';
  // Glyph ids 0x0011 0x0012 0x0013 = "Δ", "fi" (ligature), "x"; bfrange 0x0020-0x0022 -> "A".."C".
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def
1 begincodespacerange <0000> <FFFF> endcodespacerange
3 beginbfchar <0011> <0394> <0012> <00660069> <0013> <0078> endbfchar
1 beginbfrange <0020> <0022> <0041> endbfrange
endcmap CMapName currentdict /CMap defineresource pop end end`;
  const content2 = 'BT /F2 14 Tf 1 0 0 1 72 700 Tm <001100120013> Tj T* 0 -20 Td <002000210022> Tj ET';
  return pdf({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 8 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Fm1 9 0 R >> >> >>',
    4: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [10 0 R] >>',
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [128 /fi /eacute] >> >>',
    6: '<< /Type /Font /Subtype /Type0 /BaseFont /Sample /Encoding /Identity-H /DescendantFonts [11 0 R] /ToUnicode 7 0 R >>',
    7: { dict: '<< /Filter /FlateDecode >>', stream: await compress(latin(cmap), 'deflate') },
    8: { dict: '<< /Filter /FlateDecode >>', stream: await compress(latin(content1), 'deflate') },
    9: { dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 200 50] >>', stream: latin(form) },
    10: { dict: '<< /Filter /FlateDecode >>', stream: await compress(latin(content2), 'deflate') },
    11: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Sample /DW 600 /W [17 [700 500 500]] >>',
  }, { packed: [4, 5, 6, 11] });
}
