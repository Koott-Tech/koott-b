/**
 * Screening scoring.
 *
 * One engine for every instrument. A test carries its own questions, options,
 * scales and cut-offs (see migration 0017), so adding an instrument is a row in
 * the database, not a deployment.
 *
 * Two methods:
 *
 *   sum   add the items in a scale, multiply by the scale's `multiplier`, then
 *         read the band out of `severity`. DASS-21 doubles because it is the
 *         short form of the DASS-42 and the published norms are for 42 items.
 *
 *   mean  reverse-key the marked items, then take the mean. No bands — the Big
 *         Five has none.
 *
 * The percentage is computed from the ROUNDED mean, not the exact quotient.
 * That is deliberate: it is how the approved sample reports compute it, and
 * doing it the "right" way puts the printed figure out by a fraction.
 */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v));

/** Highest and lowest answer value a test accepts, read off its options. */
function optionRange(test) {
  const vals = (test.options || []).map((o) => num(o.value)).filter(Number.isFinite);
  if (!vals.length) return { min: 0, max: 0 };
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

/**
 * Check every item is present and in range.
 * Missing items are listed rather than defaulted — a silent 0 is a wrong score
 * that looks right.
 */
function validateAnswers(test, answers) {
  const { min, max } = optionRange(test);
  const missing = [];
  const outOfRange = [];
  for (const q of test.questions || []) {
    const raw = answers?.[String(q.n)];
    if (raw === undefined || raw === null || raw === '') { missing.push(q.n); continue; }
    const v = num(raw);
    if (!Number.isFinite(v) || v < min || v > max) outOfRange.push(q.n);
  }
  return { ok: !missing.length && !outOfRange.length, missing, outOfRange };
}

/** The band for a score, from an ordered [maxInclusive, label] list. */
function severityFor(test, scaleKey, score) {
  const bands = test.severity?.[scaleKey];
  if (!Array.isArray(bands) || !bands.length) return null;
  const hit = bands.find(([max]) => score <= (max === null ? Infinity : num(max)));
  return hit ? hit[1] : bands[bands.length - 1][1];
}

/**
 * @returns {{ method, scales: Array<{key,label,subtitle,score,mean,severity,percent,facets,description}> }}
 */
function scoreScreening(test, answers) {
  const { min, max } = optionRange(test);
  const method = test.method === 'mean' ? 'mean' : 'sum';
  // Reverse-keying mirrors an answer within the option range: for 1..5 that is
  // 6 - v, for 0..3 it is 3 - v. Deriving it keeps custom ranges working.
  const reverseBase = min + max;

  const byScale = new Map();
  for (const q of test.questions || []) {
    if (!q.scale) continue;
    if (!byScale.has(q.scale)) byScale.set(q.scale, []);
    const v = num(answers?.[String(q.n)]);
    byScale.get(q.scale).push(q.reverse ? reverseBase - v : v);
  }

  const scales = (test.scales || []).map((s) => {
    const vals = byScale.get(s.key) || [];
    const total = vals.reduce((a, b) => a + b, 0);
    const out = {
      key: s.key,
      label: s.label || s.key,
      subtitle: s.subtitle || null,
      facets: Array.isArray(s.facets) ? s.facets : [],
      description: s.description || '',
      count: vals.length,
    };

    if (method === 'mean') {
      const mean = vals.length ? Math.round((total / vals.length) * 100) / 100 : 0;
      out.mean = mean;
      out.score = mean;
      // From the rounded mean, matching the approved sample.
      out.percent = max > min ? ((mean - min) / (max - min)) * 100 : 0;
      out.severity = null;
    } else {
      const multiplier = num(s.multiplier) || 1;
      const score = total * multiplier;
      out.score = score;
      out.severity = severityFor(test, s.key, score);
      // Denominator: every item at its maximum, times the multiplier. A scale
      // may set `percentMax` to scale against its own "extremely severe" floor
      // instead, so the bar agrees with the severity column.
      const denom = num(s.percentMax) || (vals.length * max * multiplier);
      out.percent = denom > 0 ? (score / denom) * 100 : 0;
    }
    out.percent = Math.max(0, Math.min(100, Math.round(out.percent * 10) / 10));
    return out;
  });

  return { method, scales };
}

module.exports = { scoreScreening, validateAnswers, severityFor, optionRange };
