/**
 * Sales forecast (run rate) — pure functions, no database.
 *
 * Month (by days):  forecast = (sales on day 1 + … + sales on day N) ÷ N × days in month,
 *                   N = days of the month so far, today included.
 *   1 Nov: ₹1,00,000                   → 1,00,000 ÷ 1 × 30 = ₹30,00,000
 *   2 Nov: + ₹50,000                   → 1,50,000 ÷ 2 × 30 = ₹22,50,000
 * Several months / a year (by months, not days): each month counts as one value —
 *   a finished month its actual sales, the current month its own forecast above;
 *   forecast = sum of those ÷ months used × months in the period. Months not started yet
 *   aren't used. A period that is fully over just shows its actual sales.
 * Dates are IST calendar dates 'YYYY-MM-DD'; months 'YYYY-MM'.
 */
const pad = (n) => String(n).padStart(2, '0');
const daysInMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const monthOf = (ymd) => ymd.slice(0, 7);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function monthsBetween(fromYm, toYm) {
  const out = [];
  let [y, m] = fromYm.split('-').map(Number);
  const [ty, tm] = toYm.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${pad(m)}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
    if (out.length > 240) break; // 20 years is plenty
  }
  return out;
}

/** One month. dailySales: { 'YYYY-MM-DD': amount }. */
function forecastMonth(ym, dailySales, todayYmd) {
  const total = daysInMonth(ym);
  const todayYm = monthOf(todayYmd);
  const days = [];
  let cum = 0;
  const status = ym < todayYm ? 'past' : ym > todayYm ? 'future' : 'current';
  const elapsed = status === 'past' ? total : status === 'future' ? 0 : Number(todayYmd.slice(8, 10));
  for (let d = 1; d <= elapsed; d++) {
    const date = `${ym}-${pad(d)}`;
    const sales = Number(dailySales[date]) || 0;
    cum += sales;
    days.push({ date, sales: round2(sales), to_date: round2(cum), forecast: round2((cum / d) * total) });
  }
  const actual = round2(cum);
  return {
    month: ym,
    status,
    days_in_month: total,
    days_used: elapsed,
    actual,
    forecast: status === 'future' ? null : status === 'past' ? actual : round2((cum / elapsed) * total),
    days,
  };
}

/** A period of months (one month, several, or a year). monthly: result of forecastMonth per month. */
function forecastPeriod(monthResults) {
  const used = monthResults.filter((m) => m.status !== 'future');
  const actual = round2(monthResults.reduce((s, m) => s + (m.actual || 0), 0));
  const allPast = monthResults.every((m) => m.status === 'past');
  if (!used.length) return { actual, forecast: null, months_used: 0, months_total: monthResults.length, method: 'not started' };
  if (allPast) return { actual, forecast: actual, months_used: used.length, months_total: monthResults.length, method: 'finished' };
  if (monthResults.length === 1) {
    const m = monthResults[0];
    return { actual, forecast: m.forecast, months_used: 1, months_total: 1, days_used: m.days_used, days_total: m.days_in_month, method: 'days' };
  }
  const sum = used.reduce((s, m) => s + (m.forecast || 0), 0);
  return {
    actual,
    forecast: round2((sum / used.length) * monthResults.length),
    months_used: used.length,
    months_total: monthResults.length,
    method: 'months',
  };
}

module.exports = { daysInMonth, monthsBetween, forecastMonth, forecastPeriod, round2 };
