#!/usr/bin/env node
/**
 * Import the live jobs and event pages into the `careers` and `event_pages`
 * tables. Both were empty, which is why /jobs/<slug> rendered "Role not found"
 * and the three workshop pages had nothing behind them.
 *
 * The bodies are React-rendered on Wix (nothing useful in the served HTML), so
 * they were harvested in a browser into scripts/wix-import-data/jobsEvents.json.
 * This turns those blocks into the markdown-ish `content` shape the career and
 * event templates already render.
 *
 * Usage:
 *   node scripts/importJobsEvents.js --check
 *   node scripts/importJobsEvents.js --jobs
 *   node scripts/importJobsEvents.js --events
 *   node scripts/importJobsEvents.js --all
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { supabaseAdmin } = require('../config/supabase');

const DATA = path.join(__dirname, 'wix-import-data', 'jobsEvents.json');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

/** Wix's own page furniture, never part of the job or event copy. */
const CHROME = /^(job type|share this job with your network|share this event|whatsapp|linkedin|copy link|facebook|x|apply now|register)$/i;

/**
 * Blocks -> markdown. H2/H3 become headings, list items become bullets, and the
 * Wix sharing/meta furniture is dropped.
 */
function toMarkdown(blocks, { skipTitle }) {
  const out = [];
  const norm = (t) => t.replace(/[^a-z0-9]/gi, '').toLowerCase();
  for (const b of blocks) {
    const t = b.x.trim();
    if (!t || CHROME.test(t)) continue;
    if (b.t === 'H1') continue;                              // rendered as the page title
    if (skipTitle && norm(t) === norm(skipTitle)) continue;
    if (b.t === 'H2') { out.push('## ' + t); continue; }
    if (b.t === 'H3' || b.t === 'H4') { out.push('### ' + t); continue; }
    if (b.t === 'LI') { out.push('- ' + t); continue; }
    out.push(t);
  }
  return out.join('\n\n');
}

/** The two short lines under "Job Type" are the location and the contract type. */
function jobMeta(blocks) {
  const i = blocks.findIndex((b) => /^job type$/i.test(b.x.trim()));
  if (i === -1) return { location: null, employment_type: null };
  const after = blocks.slice(i + 1).filter((b) => b.x.length < 40 && !CHROME.test(b.x.trim()));
  return { location: after[0]?.x || null, employment_type: after[1]?.x || null };
}

async function upsertBySlug(table, row) {
  const { data: existing, error: findErr } = await supabaseAdmin
    .from(table).select('id').eq('slug', row.slug).maybeSingle();
  if (findErr) return { error: findErr };
  if (existing) {
    const { error } = await supabaseAdmin.from(table).update(row).eq('id', existing.id);
    return { error, action: 'updated' };
  }
  const { error } = await supabaseAdmin.from(table).insert([row]);
  return { error, action: 'inserted' };
}

/** Slugs on Wix carry em/en dashes; keep them URL-safe and stable. */
function cleanSlug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[–—]/g, '-')       // – —
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

async function importJobs(data) {
  let inserted = 0, updated = 0, failed = 0;
  for (const job of Object.values(data.jobs)) {
    const title = (job.blocks.find((b) => b.t === 'H1') || {}).x
      || job.title.replace(/\s*\|\s*Koott\s*$/i, '');
    const meta = jobMeta(job.blocks);
    const content = toMarkdown(job.blocks, { skipTitle: title });

    const row = {
      slug: cleanSlug(job.slug),
      title,
      // careerController treats 'open' as the public state, not 'published'.
      status: 'open',
      description: (content.split('\n\n').find((p) => p.length > 80) || '').slice(0, 500),
      location: meta.location,
      employment_type: meta.employment_type,
      content,
    };
    const { error, action } = await upsertBySlug('careers', row);
    if (error) { failed++; console.log(`  FAIL ${row.slug}: ${error.message}`); }
    else if (action === 'inserted') inserted++; else updated++;
  }
  console.log(`careers: ${inserted} inserted, ${updated} updated, ${failed} failed`);
}

async function importEvents(data) {
  let inserted = 0, updated = 0, failed = 0;
  for (const ev of Object.values(data.events)) {
    const title = (ev.blocks.find((b) => b.t === 'H1') || {}).x
      || ev.title.replace(/\s*\|\s*Koott\s*$/i, '');
    const content = toMarkdown(ev.blocks, { skipTitle: title });

    // The first two short lines are the date and the venue.
    const short = ev.blocks.filter((b) => b.t === 'P' && b.x.length < 60).map((b) => b.x);
    const when = ev.blocks.find((b) => /\d{1,2}\s+\w{3}\s+\d{4}/.test(b.x));

    const summary = (ev.blocks.find((b) => b.t === 'P' && b.x.length > 80) || {}).x || null;

    // eventPagesController.mapRowToBackend reads seo_title / seo_description /
    // cms_data out of `content`, so the page data goes under cms_data rather
    // than at the top level.
    const row = {
      slug: cleanSlug(ev.slug),
      title,
      is_published: true,
      seo_title: ev.title,
      seo_description: summary,
      content: {
        seo_title: ev.title,
        seo_description: summary,
        canonical_url: `https://www.koott.in${ev.path}`,
        cms_data: {
          title,
          summary,
          date: short[0] || null,
          venue: short[1] || null,
          schedule: when ? when.x : null,
          image: (ev.img || [])[0] || null,
          body: content,
        },
      },
    };
    const { error, action } = await upsertBySlug('event_pages', row);
    if (error) { failed++; console.log(`  FAIL ${row.slug}: ${error.message}`); }
    else if (action === 'inserted') inserted++; else updated++;
  }
  console.log(`event_pages: ${inserted} inserted, ${updated} updated, ${failed} failed`);
}

(async () => {
  if (!fs.existsSync(DATA)) { console.error('missing ' + DATA); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));

  if (!argv.length || has('--check')) {
    for (const t of ['careers', 'event_pages']) {
      const { count } = await supabaseAdmin.from(t).select('id', { count: 'exact', head: true });
      console.log(`${t}: ${count} rows`);
    }
    console.log(`local: ${Object.keys(data.jobs).length} jobs, ${Object.keys(data.events).length} events`);
    return process.exit(0);
  }
  if (has('--jobs') || has('--all')) await importJobs(data);
  if (has('--events') || has('--all')) await importEvents(data);
  for (const t of ['careers', 'event_pages']) {
    const { count } = await supabaseAdmin.from(t).select('id', { count: 'exact', head: true });
    console.log(`${t}: ${count} rows`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
