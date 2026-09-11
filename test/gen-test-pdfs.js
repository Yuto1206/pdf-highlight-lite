const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const FONT_PATH = path.join(__dirname, 'test-font.woff');

const SOURCE_PAGES = [
  ['心筋梗塞がある。', '不整脈がある。', '高血圧がある。'],
  ['心筋梗塞の説明。', '不整脈の説明。'],
  ['心筋梗塞のまとめ。'],
];

const TEXTBOOK_PAGES = [
  ['心筋梗塞について学ぶ。'],
  ['不整脈について学ぶ。'],
  ['高血圧について学ぶ。', '関係ない話もある。'],
];

if (process.argv[2] === 'chars') {
  const all = [...SOURCE_PAGES, ...TEXTBOOK_PAGES].flat().join('');
  const unique = [...new Set(all)].join('');
  console.log(unique);
  process.exit(0);
}

async function makePdf(outPath, pagesText) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const fontBytes = fs.readFileSync(FONT_PATH);
  const font = await pdfDoc.embedFont(fontBytes, { subset: false });

  for (const lines of pagesText) {
    const page = pdfDoc.addPage([420, 600]);
    let y = 560;
    for (const line of lines) {
      page.drawText(line, { x: 40, y, size: 14, font, color: rgb(0, 0, 0) });
      y -= 24;
    }
  }
  const bytes = await pdfDoc.save();
  fs.writeFileSync(outPath, bytes);
  console.log('wrote', outPath, bytes.length, 'bytes');
}

async function main() {
  await makePdf(path.join(__dirname, 'test-source.pdf'), SOURCE_PAGES);
  await makePdf(path.join(__dirname, 'test-textbook.pdf'), TEXTBOOK_PAGES);
}

main().catch(e => { console.error(e); process.exit(1); });
