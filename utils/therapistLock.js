/**
 * One booking change at a time per therapist.
 *
 * Every way of putting a session on a therapist's calendar (client checkout hold,
 * package session, credit booking, client reschedule, admin manual / package /
 * record-only booking, admin reschedule or transfer, paid-order session creation)
 * first checks the time is free and then writes. Two of them arriving together —
 * two clients on the same slot, or an admin rescheduling while a client checks out —
 * could both pass the check before either wrote, and both land. Running them one
 * after another for the same therapist closes that gap: the second sees the first.
 *
 * In-process: correct for one backend instance (how Koott runs). With several
 * instances this would need a database lock instead.
 */
const { supabaseAdmin } = require('../config/supabase');

const tails = new Map(); // key -> promise of the last queued holder
const MAX_HOLD_MS = 45 * 1000; // a stuck request never blocks a therapist for long

/** Wait for `key`, then hold it; resolves to release(). */
function acquire(key) {
  const previous = tails.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  return previous.then(() => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; console.warn('⚠️ therapistLock released by timeout:', key); release(); } }, MAX_HOLD_MS);
    return () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      release();
      if (tails.get(key) === tail) tails.delete(key);
    };
  });
}

/** Hold every key (sorted, so two requests never wait on each other in a circle). */
async function acquireAll(keys) {
  const unique = [...new Set(keys.filter(Boolean).map(String))].sort();
  const releases = [];
  for (const k of unique) releases.push(await acquire(`therapist:${k}`));
  return () => releases.reverse().forEach((r) => r());
}

/** Run fn while holding the therapist(s). */
async function withTherapistLock(psychologistIds, fn) {
  const release = await acquireAll([].concat(psychologistIds));
  try {
    return await fn();
  } finally {
    release();
  }
}

/** The therapist(s) a booking request touches, from its body, session id or package id. */
async function therapistsForRequest(req) {
  const b = req.body || {};
  const ids = [b.psychologist_id, b.psychologistId, b.new_psychologist_id, b.newPsychologistId];

  const sessionId = req.params?.sessionId;
  if (sessionId) {
    const { data } = await supabaseAdmin.from('sessions').select('psychologist_id').eq('id', sessionId).maybeSingle();
    ids.push(data?.psychologist_id);
  }
  const packageId = b.package_id;
  if (packageId && !b.psychologist_id) {
    // client_packages id (client "book remaining session") or packages id (admin "book next")
    const { data: cp } = await supabaseAdmin.from('client_packages').select('psychologist_id').eq('id', packageId).maybeSingle();
    if (cp?.psychologist_id) ids.push(cp.psychologist_id);
    else {
      const { data: pkg } = await supabaseAdmin.from('packages').select('psychologist_id').eq('id', packageId).maybeSingle();
      ids.push(pkg?.psychologist_id);
    }
  }
  return ids.filter(Boolean);
}

/**
 * Express middleware: hold the request's therapist(s) until the response is sent.
 * Requests that name no therapist pass straight through.
 */
function serializeByTherapist(req, res, next) {
  therapistsForRequest(req)
    .then(async (ids) => {
      if (!ids.length) return next();
      const release = await acquireAll(ids);
      let released = false;
      const done = () => { if (!released) { released = true; release(); } };
      res.on('finish', done);
      res.on('close', done);
      next();
    })
    .catch((e) => {
      console.warn('⚠️ therapistLock: could not resolve therapist, continuing unlocked:', e.message);
      next();
    });
}

module.exports = { withTherapistLock, serializeByTherapist };
