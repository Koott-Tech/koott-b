/**
 * The therapist profile's three list fields (SQL 0031).
 *
 * Each is plain text, one item a line, with " | " between the parts — that is what the
 * admin form edits, and this is the one place that knows the format. Blank lines and
 * missing trailing parts are fine; a line with no title is dropped.
 *
 *   approaches      Title | optional note
 *   profile_videos  Title | thumb URL | video URL
 *   profile_media   type | Title | meta | page URL | thumb URL      (type: article|video|podcast)
 */

const lines = (text) => String(text || '')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => l.split('|').map((p) => p.trim()));

const MEDIA_TYPES = new Set(['article', 'video', 'podcast']);

function parseApproaches(text) {
  return lines(text)
    .map(([title, note]) => ({ title: title || '', note: note || '' }))
    .filter((a) => a.title);
}

function parseVideos(text) {
  return lines(text)
    .map(([title, thumb, url]) => ({ title: title || '', thumb: thumb || '', url: url || '' }))
    .filter((v) => v.title);
}

function parseMedia(text) {
  return lines(text)
    .map((parts) => {
      // The type is optional: a line that starts with a title is treated as an article.
      const hasType = MEDIA_TYPES.has(String(parts[0] || '').toLowerCase());
      const [type, title, meta, url, thumb] = hasType ? parts : ['article', ...parts];
      return { type: String(type).toLowerCase(), title: title || '', meta: meta || '', url: url || '', thumb: thumb || '' };
    })
    .filter((m) => m.title);
}

/** Everything the profile screen needs, parsed, on one object. */
function profileLists(psych) {
  return {
    approaches: parseApproaches(psych?.approaches),
    profile_videos: parseVideos(psych?.profile_videos),
    profile_media: parseMedia(psych?.profile_media),
  };
}

module.exports = { parseApproaches, parseVideos, parseMedia, profileLists, MEDIA_TYPES };
