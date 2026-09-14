/**
 * Admin → Leads: numbers verified in the booking flow, booked or not
 * (booking_leads, migration 0010; written by utils/bookingAccounts.js).
 *
 *   GET /api/admin/booking-leads?status=all|verified|details|account|booked&q=text&limit=200
 *   -> { leads: [...], counts: { verified, details, account, booked } }
 */

const { supabaseAdmin } = require('../config/supabase');

const STATUSES = ['verified', 'details', 'account', 'booked'];

const list = async (req, res) => {
  try {
    const { status = 'all', q = '' } = req.query;
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);

    let query = supabaseAdmin
      .from('booking_leads')
      .select('*, psychologist:psychologists(first_name, last_name)')
      .order('updated_at', { ascending: false })
      .limit(limit);
    if (STATUSES.includes(status)) query = query.eq('status', status);
    const term = String(q).replace(/[%,()*]/g, '').trim();
    if (term) query = query.or(`phone.ilike.%${term}%,name.ilike.%${term}%,email.ilike.%${term}%`);

    const [{ data: leads, error }, { data: all, error: countError }] = await Promise.all([
      query,
      supabaseAdmin.from('booking_leads').select('status').limit(10000)
    ]);
    const failed = error || countError;
    if (failed) {
      const missing = failed.code === 'PGRST205';
      return res.status(missing ? 503 : 500).json({
        success: false,
        message: missing ? 'The leads table is missing — run supabase/RUN_PENDING_0010.sql.' : 'Could not load leads.'
      });
    }

    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    (all || []).forEach((r) => { if (r.status in counts) counts[r.status] += 1; });

    res.json({ success: true, data: { leads: leads || [], counts } });
  } catch (error) {
    console.error('❌ booking-leads list:', error.message);
    res.status(500).json({ success: false, message: 'Could not load leads.' });
  }
};

module.exports = { list };
