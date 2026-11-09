/**
 * Does an uploaded file's content match the type the browser declared? Multer only sees the
 * declared Content-Type, which the uploader controls, so an HTML page can arrive labelled
 * "application/pdf". Used by task files and staff documents (both private buckets opened
 * through signed links) so a stored file is always what it says it is.
 */
const starts = (buf, bytes, offset = 0) => bytes.every((b, i) => buf[offset + i] === b);
const ascii = (buf, s, offset = 0) => buf.slice(offset, offset + s.length).toString('latin1') === s;
const looksLikeMarkup = (buf) => /<\s*(html|script|svg|iframe|body|head|meta|object|embed)\b|javascript:/i.test(buf.slice(0, 4096).toString('utf8'));

const CHECKS = {
  'application/pdf': (b) => ascii(b, '%PDF-') && !looksLikeMarkup(b.slice(0, 1024)),
  'image/png': (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': (b) => starts(b, [0xff, 0xd8, 0xff]),
  'image/gif': (b) => ascii(b, 'GIF87a') || ascii(b, 'GIF89a'),
  'image/webp': (b) => ascii(b, 'RIFF') && ascii(b, 'WEBP', 8),
  // Office Open XML (docx / xlsx / pptx) are zip files
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (b) => starts(b, [0x50, 0x4b, 0x03, 0x04]),
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': (b) => starts(b, [0x50, 0x4b, 0x03, 0x04]),
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': (b) => starts(b, [0x50, 0x4b, 0x03, 0x04]),
  // Old Office (doc / xls): OLE compound file
  'application/msword': (b) => starts(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  'application/vnd.ms-excel': (b) => starts(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  // Text: no binary bytes, and no HTML / script that a browser could run
  'text/plain': (b) => !b.includes(0) && !looksLikeMarkup(b),
  'text/csv': (b) => !b.includes(0) && !looksLikeMarkup(b),
};

/** true when the buffer really is the declared MIME type (unknown types are refused). */
function contentMatches(mimetype, buffer) {
  const check = CHECKS[String(mimetype || '').toLowerCase()];
  if (!check || !Buffer.isBuffer(buffer) || !buffer.length) return false;
  try { return Boolean(check(buffer)); } catch (_) { return false; }
}

module.exports = { contentMatches };
