-- ============================================================================
-- 0015 — CMS: page registry, SEO/social metadata, revisions and redirects
--
-- Phase 1 of the marketing CMS. Three new tables, nothing existing is touched:
--
--   page_meta       one row per editable public page: where it lives, what it
--                   is, and the SEO/social metadata the marketing team owns.
--                   The page BODY is not here — it stays where it already
--                   lives (the `cms` table for site_home/site_about/…, and
--                   counselling_services.content for the condition pages), so
--                   this adds a metadata layer rather than a second content
--                   store to keep in sync.
--
--   page_revisions  an append-only history of content/SEO changes, so a change
--                   can be inspected and rolled back. Written on meaningful
--                   saves, never on every keystroke.
--
--   redirects       forwarding addresses. A slug may only be edited once this
--                   exists: without it, changing a published URL 404s every
--                   inbound link and loses the page's search ranking.
--
-- Every statement is additive and safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- page_meta — the registry the Pages list reads
-- ---------------------------------------------------------------------------
create table if not exists page_meta (
  -- Matches the `cms` key where one exists (site_home, site_about, …) so the
  -- two line up; otherwise any stable slug-like identifier.
  page_key    text primary key,
  name        text not null,                  -- "Home", shown in the dashboard
  path        text not null,                  -- "/", "/about-us" — the public URL
  page_type   text not null default 'static', -- static | condition | blog | system
  status      text not null default 'published',
  -- SEO: focus_keyword, title, description, canonical, robots_index,
  -- robots_follow. Kept as jsonb so a field can be added without a migration.
  seo         jsonb not null default '{}'::jsonb,
  -- Open Graph and Twitter/X, editable independently of the Google metadata.
  social      jsonb not null default '{}'::jsonb,
  -- Set to false for a page that exists but should not be offered for editing.
  editable    boolean not null default true,
  updated_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists page_meta_path_idx on page_meta (path);
create index if not exists page_meta_type_idx        on page_meta (page_type, status);

-- ---------------------------------------------------------------------------
-- page_revisions — history, append-only
-- ---------------------------------------------------------------------------
create table if not exists page_revisions (
  id         uuid primary key default gen_random_uuid(),
  page_key   text not null references page_meta(page_key) on delete cascade,
  -- What changed: 'content', 'seo', 'social', 'publish', 'restore'.
  kind       text not null,
  -- The whole value BEFORE the change, so a restore needs no reconstruction.
  before     jsonb,
  after      jsonb,
  note       text,
  user_email text,
  user_role  text,
  created_at timestamptz not null default now()
);

create index if not exists page_revisions_page_idx on page_revisions (page_key, created_at desc);

-- ---------------------------------------------------------------------------
-- redirects — 301/308 forwarding, written whenever a published path changes
-- ---------------------------------------------------------------------------
create table if not exists redirects (
  id          uuid primary key default gen_random_uuid(),
  from_path   text not null,
  to_path     text not null,
  status_code integer not null default 301,
  -- Why it exists: 'slug_change', 'manual', 'import'.
  reason      text not null default 'manual',
  is_active   boolean not null default true,
  hits        integer not null default 0,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One active destination per source; history is kept by flipping is_active.
create unique index if not exists redirects_from_active_idx
  on redirects (from_path) where is_active;
create index if not exists redirects_to_idx on redirects (to_path);

-- A redirect must not point at itself, which would loop forever.
alter table redirects drop constraint if exists redirects_no_self_loop;
alter table redirects add constraint redirects_no_self_loop check (from_path <> to_path);

-- ---------------------------------------------------------------------------
-- Seed: the pages that already have a stored-content path today.
--
-- `cms` already serves these five keys and each one's public route exists, so
-- they are editable from day one. Everything else on the site is still
-- hardcoded in its component and is registered as pages gain field schemas.
--
-- on conflict do nothing: re-running must never overwrite metadata the
-- marketing team has since edited.
-- ---------------------------------------------------------------------------
insert into page_meta (page_key, name, path, page_type, status) values
  ('site_home',    'Home',             '/',              'static', 'published'),
  ('site_about',   'About us',         '/about-us',      'static', 'published'),
  ('site_faq',     'FAQ',              '/faq',           'static', 'published'),
  ('site_pricing', 'Plans & pricing',  '/plans-pricing', 'static', 'published'),
  -- The footer is site chrome, not a page: editable, but it has no URL of its
  -- own and must never be given SEO metadata or appear in the sitemap.
  ('site_footer',  'Footer',           '/#footer',       'system', 'published')
on conflict (page_key) do nothing;

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- Same rule as 0001: the backend uses the service_role key and bypasses RLS, so
-- this does not affect the API. It matters because the anon key is shipped to
-- the browser — without RLS anyone could read these tables straight from the
-- client, and `redirects` in particular is writable, which would let a stranger
-- point any path on the site at a domain of their choosing.
--
-- RLS on with no policies = deny all for anon, which is the correct default.
-- The public site never reads these tables directly; it goes through the API.
-- ---------------------------------------------------------------------------
alter table page_meta      enable row level security;
alter table page_revisions enable row level security;
alter table redirects      enable row level security;
