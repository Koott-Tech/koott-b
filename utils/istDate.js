/**
 * Dates for the screenings, always in India time.
 *
 * toISOString() is wrong here. It reports UTC, and India is UTC+5:30, so
 * anything submitted before 05:30 IST would be filed under the previous day.
 * Every date the client sees or the report prints goes through here.
 */

const IST = 'Asia/Kolkata';

/** Today in IST as YYYY-MM-DD. en-CA is the locale that formats that way. */
const todayIst = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: IST });

/**
 * "14 March 1996" — the long form the report prints.
 *
 * A bare YYYY-MM-DD parses as UTC midnight. Rendering that in IST (which is
 * ahead of UTC) returns the same calendar day the client picked; rendering it
 * in UTC would be a day behind for most of the day.
 */
function fmtIst(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: IST });
}

/** "16 Oct 2026, 19:31 IST" — for the consent line in the email. */
function fmtIstStamp(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: IST });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: IST });
  return `${date}, ${time} IST`;
}

module.exports = { IST, todayIst, fmtIst, fmtIstStamp };
