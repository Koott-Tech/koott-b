/**
 * GET /api/me/numbers — a therapist's own numbers (plans → Therapist ideas):
 * sessions this month, clients, how many clients rebook, earnings so far this month
 * (their commission on completed sessions) and when the next payout is due.
 * Only the signed-in therapist's own data.
 */
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { supabaseAdmin } = require('../config/supabase');

const ist = () => new Date(Date.now() + 330 * 60000);
const ymd = (d) => d.toISOString().slice(0, 10);
const DONE = ['completed'];
const UPCOMING = ['booked', 'rescheduled', 'confirmed', 'scheduled', 'upcoming'];

router.get('/numbers', authenticateToken, async (req, res) => {
  try {
    if (req.user?.role !== 'psychologist') return res.status(403).json({ success: false, message: 'For therapists.' });
    const pid = req.user.id;
    const now = ist();
    const monthStart = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
    const monthEnd = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)));
    const since90 = ymd(new Date(now.getTime() - 90 * 864e5));
    const [month, recent, payouts, allDone] = await Promise.all([
      supabaseAdmin.from('sessions').select('id, client_id, status, therapist_commission, scheduled_date')
        .eq('psychologist_id', pid).gte('scheduled_date', monthStart).lte('scheduled_date', monthEnd),
      supabaseAdmin.from('sessions').select('client_id, scheduled_date, status')
        .eq('psychologist_id', pid).gte('scheduled_date', since90).in('status', [...DONE, ...UPCOMING]),
      supabaseAdmin.from('payouts').select('id, net_payout, payout_amount, amount, status, payout_date, processed_at, created_at')
        .eq('psychologist_id', pid).order('created_at', { ascending: false }).limit(12),
      supabaseAdmin.from('sessions').select('therapist_commission, scheduled_date').eq('psychologist_id', pid).in('status', DONE).limit(5000),
    ]);
    if (month.error) throw month.error;
    const m = month.data || [];
    const done = m.filter((s) => DONE.includes(s.status));
    const upcoming = m.filter((s) => UPCOMING.includes(s.status));
    const noShows = m.filter((s) => s.status === 'no_show').length;
    const earned = done.reduce((a, s) => a + Number(s.therapist_commission || 0), 0);

    // Rebooking: of clients seen in the last 90 days, how many have 2+ sessions
    const perClient = {};
    (recent.data || []).forEach((s) => { if (s.client_id) perClient[s.client_id] = (perClient[s.client_id] || 0) + 1; });
    const clients = Object.keys(perClient).length;
    const rebooked = Object.values(perClient).filter((n) => n >= 2).length;

    // Payouts: a pending one is "due"; otherwise the next run is on the 1st, for what is unpaid
    const list = payouts.data || [];
    const amountOf = (p) => Number(p.net_payout ?? p.payout_amount ?? p.amount ?? 0);
    const pending = list.find((p) => /pending|processing|approved/i.test(p.status || ''));
    const lastPaid = list.find((p) => /paid|completed|success|processed/i.test(p.status || ''));
    const lastPaidAt = lastPaid ? (lastPaid.payout_date || String(lastPaid.processed_at || lastPaid.created_at).slice(0, 10)) : null;
    const unpaid = (allDone.data || []).filter((s) => !lastPaidAt || s.scheduled_date > lastPaidAt)
      .reduce((a, s) => a + Number(s.therapist_commission || 0), 0);
    const nextRun = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));

    return res.json({
      success: true,
      data: {
        month: { label: now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }), completed: done.length, upcoming: upcoming.length, noShows, earned },
        clients90: { clients, rebooked, rate: clients ? Math.round((rebooked / clients) * 100) : null },
        payout: pending
          ? { state: 'due', amount: amountOf(pending), date: pending.payout_date || null }
          : { state: 'next_run', date: nextRun, estimate: Math.round(unpaid) },
        lastPayout: lastPaid ? { amount: amountOf(lastPaid), date: lastPaidAt } : null,
      },
    });
  } catch (e) {
    console.error('me/numbers:', e.message);
    return res.status(500).json({ success: false, message: 'Could not load your numbers.' });
  }
});

module.exports = router;
