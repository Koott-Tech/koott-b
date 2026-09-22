/**
 * Create (or reset) a marketing-dashboard login — role "marketing", totals only.
 *
 *   node scripts/createMarketingUser.js <email> ["Full name"]
 *
 * A strong random password is generated and printed once; set
 * MARKETING_USER_PASSWORD to choose it instead. Running it again for the same
 * email resets that account's password. Sign in at /marketing/login.
 */

require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { supabaseAdmin } = require('../config/supabase');

(async () => {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  const name = process.argv[3] || 'Koott Marketing';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Usage: node scripts/createMarketingUser.js <email> ["Full name"]');
    process.exit(1);
  }
  const password = process.env.MARKETING_USER_PASSWORD
    || `${crypto.randomBytes(9).toString('base64url')}#${crypto.randomInt(10, 99)}Kt`;

  const { data: existing, error: findError } = await supabaseAdmin.from('users').select('id, role').eq('email', email).maybeSingle();
  if (findError) { console.error('❌', findError.message); process.exit(1); }
  if (existing && !['marketing'].includes(existing.role)) {
    console.error(`❌ ${email} already exists with role "${existing.role}". Use a different email.`);
    process.exit(1);
  }

  const row = { email, name, role: 'marketing', password_hash: await bcrypt.hash(password, 12), is_active: true };
  const { error } = existing
    ? await supabaseAdmin.from('users').update(row).eq('id', existing.id)
    : await supabaseAdmin.from('users').insert([row]);
  if (error) { console.error('❌', error.message); process.exit(1); }

  console.log(`✅ Marketing login ${existing ? 'reset' : 'created'}`);
  console.log(`   Email:    ${email}`);
  console.log(`   Password: ${password}`);
  console.log('   Sign in at /marketing/login. Store the password somewhere safe — it is not shown again.');
  process.exit(0);
})();
