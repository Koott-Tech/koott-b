/**
 * The screening report PDF.
 *
 * Geometry is measured off the approved sample reports; the constants below are
 * those figures, not invented ones.
 *
 * Two traps, both of which cost real time if you get them wrong:
 *
 *  1. COPY the letterhead page — do not stamp the letterhead onto a fresh blank
 *     page. Its page box may not start at y=0 and its artwork may be shorter
 *     than the box, so drawing it as an overlay leaves an uncovered white strip
 *     at one edge whatever offset you pick. copyPages keeps the original box.
 *
 *  2. Letterheads are per-instrument and are NOT interchangeable: footer
 *     wording differs and some sheets already carry the explanatory note. When
 *     a sheet has it pre-printed, `note_preprinted` stops it being drawn twice.
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { fmtIst, todayIst } = require('./istDate');

const PAGE = { w: 595.5, h: 842.25 };
const INK = rgb(0x01 / 255, 0x58 / 255, 0x4a / 255);   // #01584A
const BLACK = rgb(0, 0, 0);
const BODY = rgb(0x21 / 255, 0x21 / 255, 0x21 / 255);
const GREY = rgb(0x66 / 255, 0x66 / 255, 0x66 / 255);
const NOTE_GREY = rgb(0x33 / 255, 0x33 / 255, 0x33 / 255);
const RULE = rgb(0xc9 / 255, 0xc9 / 255, 0xc9 / 255);
const TRACK = rgb(0xe8 / 255, 0xee / 255, 0xea / 255);

const L = {
  title: { x: 56.7, y: 87.4, size: 17.33 },
  detailLabel: 56.7 + 28.7,     // 85.4
  detailValue: 198.7,
  detailFirstY: 112.7,
  detailStep: 15.75,
  rule1Y: 211.9,
  ruleX: [65.8, 529.4],
  scoresY: 220.1,
  note: { x: 42.7, y: 744.9, size: 6.67 },
};

// Column sets differ per instrument; these are the measured positions.
const COLS = {
  dass: { label: 78.0, score: 168.7, severity: 220.1, head: 319.4, pct: 460.8, barX: 319.0, barW: 127.2, rule: [80.2, 515.0], lead: 12.7, gap: 1.9, facetGap: 8.3 },
  mean: { label: 70.7, score: 212.7, severity: null, head: 283.4, pct: 454.1, barX: 283.9, barW: 155.1, rule: [73.2, 522.2], lead: 12.0, gap: 2.1, facetGap: 8.7 },
};

/**
 * Standard PDF fonts are WinAnsi only, but participants type whatever they
 * like. Fold the common smart punctuation to ASCII and drop anything above
 * \xFF — except U+2022, which WinAnsi does carry and which separates the facet
 * names. A blanket strip silently deletes every separator.
 */
function winAnsi(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[^\x00-\xFF•]/g, '');
}

/** Greedy wrap to a pixel width. */
function wrap(text, font, size, maxW) {
  const words = winAnsi(text).split(/\s+/).filter(Boolean);
  const lines = []; let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(t, size) > maxW && line) { lines.push(line); line = w; }
    else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

/** The letterhead page, copied whole; a blank A4 when the file is absent. */
async function startDoc(letterhead) {
  const doc = await PDFDocument.create();
  // templates/template.pdf is the PAYMENT RECEIPT sheet — it says RECEIPT,
  // PAYABLE TO and GRAND TOTAL across the page. Stamping a clinical report onto
  // it produces something that looks like an invoice for a diagnosis, so it is
  // refused by name rather than left to a configuration mistake.
  const RECEIPT_SHEET = 'template.pdf';
  const base = letterhead ? path.basename(letterhead) : null;
  if (base === RECEIPT_SHEET) {
    throw new Error('templates/template.pdf is the payment receipt letterhead and cannot be used for an assessment report');
  }
  const file = base ? path.join(__dirname, '..', 'templates', base) : null;

  if (file && fs.existsSync(file)) {
    const src = await PDFDocument.load(fs.readFileSync(file));
    // Copy, never stamp: this keeps the sheet's own page box and artwork
    // alignment, so no white strip appears at the top or bottom edge.
    const [page] = await doc.copyPages(src, [0]);
    doc.addPage(page);
    return { doc, page, hadLetterhead: true };
  }
  return { doc, page: doc.addPage([PAGE.w, PAGE.h]), hadLetterhead: false };
}

/**
 * @param {object} test   the screening_tests row
 * @param {object} person { name, email, phone, dob, sex, assessmentDate }
 * @param {object} result from scoreScreening()
 * @returns {Promise<Buffer>}
 */
async function buildReport({ test, person, result }) {
  const { doc, page, hadLetterhead } = await startDoc(test.letterhead);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const boldItalic = await doc.embedFont(StandardFonts.HelveticaBoldOblique);

  const H = page.getHeight();
  // pdf-lib's origin is bottom-left; the measurements are from the top.
  const T = (y) => H - y;
  const draw = (text, { x, y, size, font = reg, color = BLACK }) =>
    page.drawText(winAnsi(text), { x, y: T(y), size, font, color });

  const cols = result.method === 'mean' ? COLS.mean : COLS.dass;

  draw(test.name || 'Assessment report', { ...L.title, font: bold, color: INK });

  // ---- participant details -------------------------------------------------
  const blank = '_'.repeat(31);   // an unfilled field is underscores, not a rule
  const rows = [
    ['Name', person.name || 'Not provided'],
    ['Date of assessment', person.assessmentDate || fmtIst(todayIst())],
    ['Sex', person.sex],
    ['Email ID', person.email],
    ['Phone number', person.phone],
    ['Date of birth', person.dob],
  ];
  rows.forEach(([label, value], i) => {
    const y = L.detailFirstY + i * L.detailStep;
    draw(`${label}`, { x: L.detailLabel, y, size: 10, font: bold });
    draw(value ? String(value) : blank, { x: L.detailValue, y, size: 10 });
  });

  page.drawLine({
    start: { x: L.ruleX[0], y: T(L.rule1Y) }, end: { x: L.ruleX[1], y: T(L.rule1Y) },
    thickness: 0.72, color: RULE,
  });
  draw('Scores', { x: L.detailLabel - 7.4, y: L.scoresY, size: 12, font: bold, color: INK });

  // ---- score table ---------------------------------------------------------
  let y = L.scoresY + 22;
  for (const s of result.scales) {
    draw(s.label, { x: cols.label, y, size: 10, font: bold });
    const figure = result.method === 'mean' ? s.mean.toFixed(2) : String(s.score);
    draw(figure, { x: cols.score, y, size: 10, font: bold, color: INK });
    if (cols.severity && s.severity) draw(s.severity, { x: cols.severity, y, size: 10 });

    page.drawRectangle({
      x: cols.barX, y: T(y + 8.5 + 1.05), width: cols.barW, height: 8.5, color: TRACK,
    });
    page.drawRectangle({
      x: cols.barX, y: T(y + 8.5 + 1.05), width: cols.barW * (s.percent / 100), height: 8.5, color: INK,
    });
    draw(`${s.percent.toFixed(1)}%`, { x: cols.pct, y, size: 10 });

    y += 18;
    page.drawLine({
      start: { x: cols.rule[0], y: T(y - 4) }, end: { x: cols.rule[1], y: T(y - 4) },
      thickness: 0.72, color: RULE,
    });
    y += 6;
  }

  // ---- per-scale write-up --------------------------------------------------
  y += 10;
  const contentW = 539.1 - 56.7;
  for (const s of result.scales) {
    draw(s.label, { x: 56.7, y, size: 10.67, font: bold, color: INK });
    if (s.subtitle) {
      const w = bold.widthOfTextAtSize(winAnsi(s.label), 10.67);
      draw(s.subtitle, { x: 56.7 + w + 6, y, size: 9.33, color: GREY });
    }
    y += 14;

    for (const line of wrap(s.description, reg, 9.33, contentW)) {
      draw(line, { x: 56.7, y, size: 9.33, color: BODY });
      y += cols.lead;
    }
    y += cols.gap;

    if (s.facets?.length) {
      // U+2022 survives winAnsi() on purpose — strip it and the list runs together.
      for (const line of wrap(s.facets.join(' • '), boldItalic, 9.33, contentW)) {
        draw(line, { x: 56.7, y, size: 9.33, font: boldItalic, color: INK });
        y += cols.lead;
      }
    }
    y += cols.facetGap;
  }

  // ---- note ----------------------------------------------------------------
  // Only when the sheet does not already carry it, or it prints twice.
  if (!test.note_preprinted && test.report_note) {
    let ny = L.note.y;
    for (const line of wrap(test.report_note, reg, L.note.size, PAGE.w - L.note.x * 2)) {
      draw(line, { x: L.note.x, y: ny, size: L.note.size, color: NOTE_GREY });
      ny += L.note.size + 1.6;
    }
  }

  return { pdf: Buffer.from(await doc.save()), hadLetterhead };
}

module.exports = { buildReport, winAnsi, wrap };
