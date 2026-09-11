const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const { PDFDocument, rgb } = require('pdf-lib');

// ── index.html と同一ロジック ──────────────────────────────
const TERM_RUN = /[一-鿿々゠-ヿー々]{2,}/g;
const STOPWORDS = new Set([
  '場合', '必要', '症状', '患者', '存在', '効果', '重要', '程度', '出現', '低下',
  '原因', '発生', '報告', '分類', '適応', '状態', '診断', '検査', '可能', '一般',
  '以下', '以上', '複数', '場所', '部位', '方法', '種類', '特徴', '機能', '変化',
  '影響', '対応', '確認', '実施', '使用', '上昇', '増加', '減少', '判断', '評価',
  '検討', '注意', '観察', '経過', '説明', '講義', '内容', '概要', '目的', '対象',
  '今回', '実際', '一部', '全体', '主要', '関連', '関係', '基本', '発症', '予防',
  '合併', '治療法', '令和', '平成', '昭和', 'コース', 'チャプター', 'ページ',
  '可能性', '有無',
]);
const ZONE_RATIO = 0.08;
const ZONE_MIN_PAGE_RATIO = 0.5;
const ZONE_MIN_PAGES = 4;

function detectZoneTerms(pages) {
  if (pages.length < ZONE_MIN_PAGES) return new Set();
  const zonePageCount = {};
  for (const pg of pages) {
    const topThresh = pg.height * (1 - ZONE_RATIO);
    const bottomThresh = pg.height * ZONE_RATIO;
    const zoneItems = pg.items.filter(it => {
      const y = it.transform[5];
      return y >= topThresh || y <= bottomThresh;
    });
    const zoneText = zoneItems.map(it => it.str).join('');
    const uniqueTerms = new Set(zoneText.match(TERM_RUN) || []);
    for (const term of uniqueTerms) {
      zonePageCount[term] = (zonePageCount[term] || 0) + 1;
    }
  }
  const zoneTerms = new Set();
  for (const [term, count] of Object.entries(zonePageCount)) {
    if (count / pages.length >= ZONE_MIN_PAGE_RATIO) zoneTerms.add(term);
  }
  return zoneTerms;
}

function extractTermCounts(sourceTexts, boilerplateTerms) {
  const counts = {};
  const fullText = sourceTexts.join('');
  const matches = fullText.match(TERM_RUN) || [];
  for (const term of matches) {
    if (STOPWORDS.has(term) || boilerplateTerms.has(term)) continue;
    counts[term] = (counts[term] || 0) + 1;
  }
  return counts;
}

async function extractPageGeometry(pdfDoc) {
  const pages = [];
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pages.push({ height: viewport.height, items: content.items });
  }
  return pages;
}

async function extractLines(pdfDoc, onPageProgress) {
  const pages = [];
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p);
    const content = await page.getTextContent();

    const charRecords = [];
    for (const item of content.items) {
      const str = item.str;
      if (!str) continue;
      const tx = item.transform;
      const x0 = tx[4];
      const y0 = tx[5];
      const totalWidth = item.width || 0;
      const height = item.height || Math.abs(tx[3]) || 10;
      const n = str.length;
      const charWidth = n > 0 ? totalWidth / n : 0;
      for (let i = 0; i < n; i++) {
        charRecords.push({
          ch: str[i],
          x: x0 + charWidth * i,
          y: y0,
          width: charWidth,
          height: height,
        });
      }
    }

    charRecords.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const Y_TOL = 2.5;
    const lines = [];
    for (const rec of charRecords) {
      let line = lines.length ? lines[lines.length - 1] : null;
      if (!line || Math.abs(line.y - rec.y) > Y_TOL) {
        line = { y: rec.y, chars: [] };
        lines.push(line);
      }
      line.chars.push(rec);
    }
    for (const line of lines) {
      line.chars.sort((a, b) => a.x - b.x);
      line.text = line.chars.map(c => c.ch).join('');
    }
    pages.push({ pageNum: p, lines });
    if (onPageProgress) onPageProgress(p, pdfDoc.numPages);
  }
  return pages;
}

async function extractFullText(pdfDoc) {
  let text = '';
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join('') + '\n';
  }
  return text;
}

function findMatches(pages, termCounts) {
  const terms = Object.keys(termCounts).sort((a, b) => b.length - a.length);
  const matches = [];
  for (const page of pages) {
    for (const line of page.lines) {
      const text = line.text;
      const claimed = new Array(text.length).fill(false);
      for (const term of terms) {
        let idx = 0;
        while ((idx = text.indexOf(term, idx)) !== -1) {
          const end = idx + term.length;
          let overlap = false;
          for (let k = idx; k < end; k++) { if (claimed[k]) { overlap = true; break; } }
          if (!overlap) {
            for (let k = idx; k < end; k++) claimed[k] = true;
            const startChar = line.chars[idx];
            const endChar = line.chars[end - 1];
            matches.push({
              pageNum: page.pageNum,
              x: startChar.x,
              y: startChar.y,
              width: (endChar.x + endChar.width) - startChar.x,
              height: Math.max(startChar.height, endChar.height),
              term,
              count: termCounts[term],
            });
          }
          idx += 1;
        }
      }
    }
  }
  return matches;
}

function tierColor(count) {
  if (count >= 5) return { r: 1, g: 0.45, b: 0.45 };
  if (count >= 3) return { r: 0.4, g: 0.87, b: 0.4 };
  return { r: 1, g: 0.93, b: 0.2 };
}

async function generateHighlightedPdf(originalArrayBuffer, matches) {
  const pdfDoc = await PDFDocument.load(originalArrayBuffer);
  const pages = pdfDoc.getPages();
  for (const m of matches) {
    const page = pages[m.pageNum - 1];
    if (!page) continue;
    const color = tierColor(m.count);
    page.drawRectangle({
      x: m.x,
      y: m.y - 1,
      width: Math.max(m.width, 2),
      height: m.height + 3,
      color: rgb(color.r, color.g, color.b),
      opacity: 0.45,
    });
  }
  return await pdfDoc.save();
}

// ── テスト実行 ──────────────────────────────────────────
async function main() {
  const dir = __dirname;
  const sourceBuf = new Uint8Array(fs.readFileSync(path.join(dir, 'test-source.pdf')));
  const textbookBuf = new Uint8Array(fs.readFileSync(path.join(dir, 'test-textbook.pdf')));

  const sourcePdf = await pdfjsLib.getDocument({ data: sourceBuf }).promise;
  const sourceText = await extractFullText(sourcePdf);
  console.log('--- source extracted text ---');
  console.log(JSON.stringify(sourceText));

  const termCounts = extractTermCounts([sourceText], new Set());
  console.log('--- term counts ---');
  console.log(termCounts);

  const expected = { '心筋梗塞': 3, '不整脈': 2, '高血圧': 1 };
  let termsOk = true;
  for (const [k, v] of Object.entries(expected)) {
    if (termCounts[k] !== v) {
      console.error(`MISMATCH: term "${k}" expected count ${v}, got ${termCounts[k]}`);
      termsOk = false;
    }
  }
  console.log(termsOk ? 'PASS: term counts match expected' : 'FAIL: term counts');

  const textbookPdf = await pdfjsLib.getDocument({ data: textbookBuf }).promise;
  const pages = await extractLines(textbookPdf);
  console.log('--- textbook lines per page ---');
  for (const pg of pages) {
    console.log(`page ${pg.pageNum}:`, pg.lines.map(l => l.text));
  }

  const matches = findMatches(pages, termCounts);
  console.log('--- matches found ---');
  for (const m of matches) {
    console.log(`page ${m.pageNum}: "${m.term}" (count=${m.count}) at x=${m.x.toFixed(1)} y=${m.y.toFixed(1)} w=${m.width.toFixed(1)} h=${m.height.toFixed(1)}`);
  }

  const expectedTermsInTextbook = ['心筋梗塞', '不整脈', '高血圧'];
  const foundTerms = new Set(matches.map(m => m.term));
  let matchOk = true;
  for (const t of expectedTermsInTextbook) {
    if (!foundTerms.has(t)) {
      console.error(`MISMATCH: expected match for "${t}" not found in textbook`);
      matchOk = false;
    }
  }
  if (matches.some(m => m.term === '関係')) {
    console.error('MISMATCH: unexpected term "関係" should not be extracted from source (not in source doc)');
    matchOk = false;
  }
  console.log(matchOk ? 'PASS: expected matches found, no false positives' : 'FAIL: match content');

  // 座標の妥当性チェック（幅・高さが正の値で、ページ内に収まっているか）
  let coordsOk = true;
  for (const m of matches) {
    if (!(m.width > 0 && m.height > 0)) {
      console.error(`MISMATCH: non-positive size for match "${m.term}" w=${m.width} h=${m.height}`);
      coordsOk = false;
    }
    if (m.x < 0 || m.y < 0 || m.x > 420 || m.y > 600) {
      console.error(`MISMATCH: out-of-page coords for match "${m.term}" x=${m.x} y=${m.y}`);
      coordsOk = false;
    }
  }
  console.log(coordsOk ? 'PASS: coordinates look sane' : 'FAIL: coordinates');

  const outBytes = await generateHighlightedPdf(textbookBuf, matches);
  const outPath = path.join(dir, 'test-output-highlighted.pdf');
  fs.writeFileSync(outPath, outBytes);
  console.log('wrote', outPath, outBytes.length, 'bytes (original was', textbookBuf.length, ')');

  // 出力PDFが正しく読み込めるか（壊れていないか）を再検証
  const reloaded = await PDFDocument.load(outBytes);
  console.log('PASS: output PDF reloads OK, pages =', reloaded.getPageCount());

  const allPass = termsOk && matchOk && coordsOk;
  console.log(allPass ? '\n=== ALL CHECKS PASSED ===' : '\n=== SOME CHECKS FAILED ===');
  process.exit(allPass ? 0 : 1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
