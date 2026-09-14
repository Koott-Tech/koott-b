/**
 * Order of the therapist cards on the public site.
 *
 *   booking  /book-malayali-psychologists — the admin's group pattern, e.g.
 *            [A, B, C] or [A, B, B, C]. Each position shows the soonest-available
 *            therapist of that group not shown yet, so the card reserved for a
 *            group changes as slots are booked. The pattern repeats (unless
 *            switched off); everyone left — ungrouped therapists, groups not in the
 *            pattern, groups that ran out — follows by soonest availability.
 *   default  home page and condition / CMS pages — soonest availability first.
 *
 * "Soonest availability" is the first bookable start in the next 21 days
 * (individual 50-min grid; psychiatrists on 15-min consults). Therapists with no
 * free slot go last; ties fall back to display_order, then name.
 *
 * Group membership never leaves the backend: the public endpoint returns only
 * therapist ids and their next free time.
 */

const { supabaseAdmin } = require('../config/supabase');
const { getBookableSlots } = require('./sessionSlots');

const PATTERN_KEY = 'therapist_listing_pattern';  // cms row — not in the public site-config whitelist
const WINDOW_DAYS = 21;
const CACHE_MS = 2 * 60 * 1000;
const MAX_POSITIONS = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READY_MSG = 'Therapist groups need the database update — run backend/supabase/RUN_PENDING.sql in the Supabase SQL editor.';

const assessmentEmail = () => (process.env.FREE_ASSESSMENT_PSYCHOLOGIST_EMAIL || 'assessment.koott@gmail.com').toLowerCase();
const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const shiftDay = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const fullName = (t) => `${t.first_name || ''} ${t.last_name || ''}`.trim();
const missingGroups = (error) => ['42P01', 'PGRST205', '42703'].includes(error?.code) || /therapist_group/.test(error?.message || '');

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

/** Active, client-facing therapists (same filter as /api/public/psychologists). */
async function loadTherapists() {
  const run = (cols) => supabaseAdmin
    .from('psychologists')
    .select(cols)
    .eq('is_active', true)
    .neq('email', assessmentEmail());
  let { data, error } = await run('id, first_name, last_name, designation, display_order, therapist_group_id');
  if (error && missingGroups(error)) ({ data, error } = await run('id, first_name, last_name, designation, display_order'));
  if (error) throw error;
  return data || [];
}

async function computeSnapshot() {
  const therapists = await loadTherapists();
  const from = istToday();
  const to = shiftDay(from, WINDOW_DAYS);
  const next = new Map();
  await mapLimit(therapists, 4, async (t) => {
    const kind = /psychiatr/i.test(t.designation || '') ? 'psychiatry_15' : 'individual';
    try {
      const days = await getBookableSlots(t.id, from, to, kind);
      const first = days[0]?.slots?.[0];
      next.set(t.id, first ? { startsAt: first.startsAt, date: days[0].date, time: first.time } : null);
    } catch (err) {
      console.error(`therapist listing: slots unavailable for ${t.id}:`, err.message);
      next.set(t.id, null);
    }
  });
  return { therapists, next };
}

// Next-availability for every therapist is a handful of queries each; cache it briefly.
let cache = { at: 0, value: null, pending: null };
function snapshot() {
  if (cache.value && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.value);
  if (!cache.pending) {
    cache.pending = computeSnapshot()
      .then((value) => { cache = { at: Date.now(), value, pending: null }; return value; })
      .catch((err) => { cache.pending = null; throw err; });
  }
  return cache.pending;
}
const invalidateListingCache = () => { cache = { at: 0, value: null, pending: null }; };

const byAvailability = (next) => (a, b) => {
  const na = next.get(a.id)?.startsAt;
  const nb = next.get(b.id)?.startsAt;
  if (na && nb && na !== nb) return na < nb ? -1 : 1;
  if (na && !nb) return -1;
  if (!na && nb) return 1;
  const oa = a.display_order ?? Number.MAX_SAFE_INTEGER;
  const ob = b.display_order ?? Number.MAX_SAFE_INTEGER;
  if (oa !== ob) return oa - ob;
  return fullName(a).localeCompare(fullName(b));
};

async function getListingPattern() {
  const { data, error } = await supabaseAdmin.from('cms').select('data, updated_at').eq('key', PATTERN_KEY).maybeSingle();
  if (error) throw error;
  const d = data?.data || {};
  return {
    pattern: Array.isArray(d.pattern) ? d.pattern.filter((g) => UUID_RE.test(String(g))) : [],
    repeat: d.repeat !== false,
    updatedAt: data?.updated_at || null,
  };
}

async function saveListingPattern(input = {}) {
  const pattern = Array.isArray(input.pattern) ? input.pattern.map(String) : null;
  if (!pattern) return { success: false, status: 400, message: 'The pattern must be a list of groups' };
  if (pattern.length > MAX_POSITIONS) return { success: false, status: 400, message: `Keep the pattern to ${MAX_POSITIONS} cards or fewer` };
  if (pattern.some((g) => !UUID_RE.test(g))) return { success: false, status: 400, message: 'Every card needs a group' };

  if (pattern.length) {
    const { data, error } = await supabaseAdmin.from('therapist_groups').select('id').in('id', [...new Set(pattern)]);
    if (error) {
      if (missingGroups(error)) return { success: false, status: 409, message: READY_MSG };
      throw error;
    }
    const known = new Set((data || []).map((g) => g.id));
    if (pattern.some((g) => !known.has(g))) return { success: false, status: 400, message: 'One of the groups no longer exists — reload and try again' };
  }

  const value = { pattern, repeat: input.repeat !== false };
  const { error } = await supabaseAdmin
    .from('cms')
    .upsert({ key: PATTERN_KEY, data: value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
  return {
    success: true,
    message: pattern.length ? 'Booking-page order saved' : 'Pattern cleared — the booking page shows the soonest-available therapists first',
    ...value,
  };
}

/** Cards in order: [{ therapist, groupId, fromPattern }]. */
async function orderedCards(list) {
  const { therapists, next } = await snapshot();
  const sorted = [...therapists].sort(byAvailability(next));
  if (list !== 'booking') return { cards: sorted.map((t) => ({ therapist: t, fromPattern: false })), next, applied: false };

  const { pattern, repeat } = await getListingPattern().catch(() => ({ pattern: [], repeat: true }));
  const present = new Set(therapists.map((t) => t.therapist_group_id).filter(Boolean));
  const usable = pattern.filter((g) => present.has(g));
  if (!usable.length) return { cards: sorted.map((t) => ({ therapist: t, fromPattern: false })), next, applied: false };

  const queues = new Map();
  usable.forEach((g) => { if (!queues.has(g)) queues.set(g, sorted.filter((t) => t.therapist_group_id === g)); });
  const cards = [];
  const used = new Set();
  for (;;) {
    let took = false;
    for (const g of usable) {
      const q = queues.get(g);
      if (q.length) {
        const t = q.shift();
        cards.push({ therapist: t, fromPattern: true });
        used.add(t.id);
        took = true;
      }
    }
    if (!took || !repeat) break;
  }
  sorted.forEach((t) => { if (!used.has(t.id)) cards.push({ therapist: t, fromPattern: false }); });
  return { cards, next, applied: true };
}

/** Public: ids + next free time only. list = 'booking' | 'default'. */
async function listingOrder(list = 'default') {
  const { cards, next, applied } = await orderedCards(list);
  return {
    list,
    patternApplied: applied,
    order: cards.map(({ therapist }) => ({ id: therapist.id, nextAvailableAt: next.get(therapist.id)?.startsAt || null })),
  };
}

/** Admin: the booking-page order with names and groups, for the pattern editor. */
async function listingPreview() {
  const { cards, next, applied } = await orderedCards('booking');
  let groups = new Map();
  const { data, error } = await supabaseAdmin.from('therapist_groups').select('id, name, color');
  if (!error) groups = new Map((data || []).map((g) => [g.id, g]));
  return {
    patternApplied: applied,
    cards: cards.map(({ therapist: t, fromPattern }, i) => {
      const g = groups.get(t.therapist_group_id);
      return {
        position: i + 1,
        id: t.id,
        name: fullName(t),
        designation: t.designation || '',
        groupName: g?.name || null,
        groupColor: g?.color || null,
        fromPattern,
        nextAvailableAt: next.get(t.id)?.startsAt || null,
      };
    }),
  };
}

module.exports = { listingOrder, listingPreview, getListingPattern, saveListingPattern, invalidateListingCache };
