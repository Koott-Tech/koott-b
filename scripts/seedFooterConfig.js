#!/usr/bin/env node
/**
 * Seed `cms.key = 'site_footer'` with the footer configuration.
 *
 * The footer renders from this row and falls back to
 * frontend/src/data/footerConfig.js when it is absent, so seeding is optional —
 * it is what makes the footer editable without a deploy.
 *
 * Usage:
 *   node scripts/seedFooterConfig.js          seed only if missing
 *   node scripts/seedFooterConfig.js --force  overwrite whatever is stored
 *   node scripts/seedFooterConfig.js --show   print the stored row
 */

require('dotenv').config();
const fs = require('fs');
const { supabaseAdmin } = require('../config/supabase');

const KEY = 'site_footer';

// The footer config lives in frontend/src/data/footerConfig.js — that file is
// what the component falls back to, so this script reads it rather than keeping
// a second copy that can drift out of step. It is an ES module, so the object
// literal is lifted out and evaluated rather than required.
const path = require('path');

function loadFooterConfig() {
  const file = path.join(__dirname, '..', '..', 'frontend', 'src', 'data', 'footerConfig.js');
  const src = fs.readFileSync(file, 'utf8');
  const from = src.indexOf('export const DEFAULT_FOOTER = ');
  if (from < 0) throw new Error('DEFAULT_FOOTER not found in ' + file);
  const open = src.indexOf('{', from);
  const close = src.indexOf('\n};', open);
  if (close < 0) throw new Error('could not find the end of DEFAULT_FOOTER');
  // eslint-disable-next-line no-eval
  return eval('(' + src.slice(open, close + 2) + ')');
}

const FOOTER = loadFooterConfig();

(async () => {
  const argv = process.argv.slice(2);
  const { data: existing, error: readErr } = await supabaseAdmin
    .from('cms').select('key,data,updated_at').eq('key', KEY).maybeSingle();

  if (readErr) {
    console.error('could not read cms table:', readErr.message);
    process.exit(1);
  }

  if (argv.includes('--show')) {
    console.log(existing ? JSON.stringify(existing.data, null, 1) : '(no row stored)');
    process.exit(0);
  }

  if (existing && !argv.includes('--force')) {
    const links = (existing.data?.columns || []).reduce((a, c) => a + (c.links?.length || 0), 0);
    console.log(`already seeded (${links} column links, updated ${existing.updated_at}). Use --force to overwrite.`);
    process.exit(0);
  }

  const { error } = await supabaseAdmin
    .from('cms')
    .upsert({ key: KEY, data: FOOTER, updated_at: new Date().toISOString() }, { onConflict: 'key' });

  if (error) {
    console.error('seed failed:', error.message);
    process.exit(1);
  }

  const count = (cols) => (cols || []).reduce((a, c) => a + c.links.length, 0);
  const total = count(FOOTER.columns) + count(FOOTER.lowerColumns);
  console.log(`seeded '${KEY}': ${FOOTER.columns.length} columns, ${total} links`);
  process.exit(0);
})();
