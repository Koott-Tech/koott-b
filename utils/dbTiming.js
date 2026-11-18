/**
 * Dev-only database timing per request (DEBUG_DB_TIMING=1). Off by default: nothing is
 * recorded and the middleware is a pass-through.
 *
 * Every Supabase call made while handling a request is recorded (config/supabase.js calls
 * record()). Just before the response goes out, three headers are added:
 *   X-DB-Calls   how many database calls the request made
 *   X-DB-Ms      their total time (sum; calls running together count each)
 *   X-DB-Rounds  how many of them ran one after another — the longest chain of calls that did
 *                not overlap. Each round costs a full network round trip to the database, so
 *                this is what makes an endpoint slow from far away.
 * Work still running after the response was sent is not counted.
 */
const { AsyncLocalStorage } = require('async_hooks');

const ENABLED = process.env.DEBUG_DB_TIMING === '1';
const store = new AsyncLocalStorage();

const TRACE = ENABLED && process.env.DEBUG_DB_TRACE === '1';
const fs = require('fs');
const path = require('path');
const TRACE_FILE = path.join(__dirname, '..', 'logs', 'db-trace.jsonl');

/** what: "GET users?select=…" (method + table + query, trimmed) — kept only when tracing. */
function record(start, end, what) {
  if (!ENABLED) return;
  const ctx = store.getStore();
  if (ctx && !ctx.sent) ctx.calls.push(TRACE ? [start, end, what] : [start, end]);
}

/** Longest chain of non-overlapping calls (greedy interval scheduling by end time). */
function sequentialRounds(calls) {
  const sorted = [...calls].sort((a, b) => a[1] - b[1]);
  let rounds = 0;
  let lastEnd = -Infinity;
  for (const [s, e] of sorted) {
    if (s >= lastEnd - 1) { rounds += 1; lastEnd = e; }
  }
  return rounds;
}

function middleware(req, res, next) {
  if (!ENABLED) return next();
  const ctx = { calls: [], sent: false, t0: performance.now() };
  const writeHead = res.writeHead;
  res.writeHead = function writeHeadWithDbTiming(...args) {
    try {
      ctx.sent = true;
      res.setHeader('X-DB-Calls', String(ctx.calls.length));
      res.setHeader('X-DB-Ms', String(Math.round(ctx.calls.reduce((sum, [s, e]) => sum + (e - s), 0))));
      res.setHeader('X-DB-Rounds', String(sequentialRounds(ctx.calls)));
      res.setHeader('Access-Control-Expose-Headers', 'X-DB-Calls, X-DB-Ms, X-DB-Rounds');
      if (TRACE) {
        // DEBUG_DB_TRACE=1: one JSON line per request with each call's start, length and target.
        fs.mkdirSync(path.dirname(TRACE_FILE), { recursive: true });
        fs.appendFileSync(TRACE_FILE, `${JSON.stringify({
          at: new Date().toISOString(), method: req.method, url: req.originalUrl.slice(0, 200),
          ms: Math.round(performance.now() - ctx.t0),
          calls: ctx.calls.map(([s, e, w]) => [Math.round(s - ctx.t0), Math.round(e - s), w]),
        })}
`);
      }
    } catch (_) { /* headers already sent */ }
    return writeHead.apply(this, args);
  };
  return store.run(ctx, next);
}

module.exports = { ENABLED, record, middleware };
