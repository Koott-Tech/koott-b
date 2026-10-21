-- ============================================================================
-- 0011 · First-party analytics + marketing dashboard
--
-- Koott's own record of the funnel, from first visit to verified paid booking.
-- Nothing here is sent to Meta or Google; the outbox only queues it, and each
-- platform gets a separately allowlisted payload later (see docs/analytics).
--
-- Adds tables only. The one touch on an existing table is a trigger on
-- payments, which queues an analytics row whenever a Razorpay payment becomes
-- 'success', 'failed' or 'refunded' — whichever code path made that change
-- (webhook, success callback, status poll, recovery job). It never blocks or
-- fails the payment update: the insert is ON CONFLICT DO NOTHING.
--
-- Safe to re-run. Rollback is at the bottom of the file.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Events: every funnel step, page view and interaction, one row each.
-- ---------------------------------------------------------------------------
create table if not exists analytics_events (
  id                bigint generated always as identity primary key,
  event_id          text not null unique,          -- browser uuid, or purchase_<payment id> etc. for server events
  event_name        text not null,
  occurred_at       timestamptz not null,
  received_at       timestamptz not null default now(),
  environment       text not null default 'production',  -- production · staging · development
  source            text not null default 'browser',     -- browser · server
  anonymous_id      uuid,
  user_id           uuid,
  session_id        uuid,
  page_path         text,                           -- internal only; never sent to ad platforms as-is
  page_group        text,                           -- home · listing · profile · booking · payment · condition · blog · service · account · other
  page_topic        text,                           -- condition pages grouped into topics (internal, aggregate)
  landing_group     text,                           -- page group the session started on
  landing_topic     text,
  channel           text,                           -- the session's channel (paid_social, paid_search, …)
  first_channel     text,                           -- the visitor's first-ever channel
  utm_source        text,
  utm_medium        text,
  utm_campaign      text,
  utm_content       text,
  utm_term          text,
  referrer_host     text,
  device_class      text,                           -- mobile · tablet · desktop
  region            text,                           -- from the browser time zone, never from IP
  is_bot            boolean not null default false,
  payment_id        uuid,
  psychologist_id   uuid,
  value             numeric(12,2),
  currency          char(3),
  props             jsonb not null default '{}'::jsonb   -- closed, validated set per event
);
create index if not exists analytics_events_name_time_idx on analytics_events (environment, event_name, occurred_at);
create index if not exists analytics_events_time_idx      on analytics_events (occurred_at);
create index if not exists analytics_events_anon_idx      on analytics_events (anonymous_id);
create index if not exists analytics_events_user_idx      on analytics_events (user_id) where user_id is not null;
create index if not exists analytics_events_session_idx   on analytics_events (session_id);
create index if not exists analytics_events_payment_idx   on analytics_events (payment_id) where payment_id is not null;
create index if not exists analytics_events_campaign_idx  on analytics_events (utm_source, utm_campaign);

-- anonymous visitor ↔ signed-in user (history stays under the anonymous id)
create table if not exists analytics_identities (
  anonymous_id  uuid not null,
  user_id       uuid not null,
  linked_at     timestamptz not null default now(),
  primary key (anonymous_id, user_id)
);
create index if not exists analytics_identities_user_idx on analytics_identities (user_id);

-- first and last touch per visitor
create table if not exists visitor_attribution (
  anonymous_id        uuid primary key,
  user_id             uuid,
  environment         text not null default 'production',
  first_channel       text, first_source text, first_medium text, first_campaign text,
  first_landing_group text, first_referrer_host text,
  last_channel        text, last_source text, last_medium text, last_campaign text,
  fbclid text, gclid text, gbraid text, wbraid text,   -- cleared after 90 days
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now()
);

-- frozen when the Razorpay order is created; later visits never change it
create table if not exists booking_attribution (
  payment_id           uuid primary key references payments(id) on delete cascade,
  client_id            uuid,
  psychologist_id      uuid,
  environment          text not null default 'production',
  anonymous_id         uuid,
  analytics_session_id uuid,
  first_channel text, first_source text, first_medium text, first_campaign text,
  last_channel  text, last_source  text, last_medium  text, last_campaign  text,
  utm_content text, utm_term text,
  landing_group text, landing_topic text,
  device_class text, region text,
  fbclid text, fbc text, fbp text, gclid text, gbraid text, wbraid text,
  ga_client_id text, ga_session_id text,
  client_ip inet, client_user_agent text,          -- nulled 30 days after delivery
  consent_analytics   boolean not null default false,
  consent_advertising boolean not null default false,
  consent_version text,
  created_at timestamptz not null default now()
);
create index if not exists booking_attribution_channel_idx on booking_attribution (last_channel, created_at);

-- verified phone numbers (booking_leads) ↔ the visit they came from
create table if not exists lead_attribution (
  phone          text primary key,
  anonymous_id   uuid,
  environment    text not null default 'production',
  first_channel  text, last_channel text, last_source text, last_medium text, last_campaign text,
  landing_group  text, device_class text, region text,
  created_at     timestamptz not null default now()
);

-- proof of each cookie choice (kept 3 years)
create table if not exists consent_records (
  id            bigint generated always as identity primary key,
  anonymous_id  uuid not null,
  user_id       uuid,
  environment   text not null default 'production',
  analytics     boolean not null,
  advertising   boolean not null,
  version       text not null,
  source        text not null default 'banner',    -- banner · settings
  recorded_at   timestamptz not null default now()
);
create index if not exists consent_records_time_idx on consent_records (recorded_at);

-- ---------------------------------------------------------------------------
-- Outbox: queued work, delivered by the backend worker with retries.
-- ---------------------------------------------------------------------------
create table if not exists analytics_outbox (
  id               bigint generated always as identity primary key,
  event_id         text not null,
  event_name       text not null,
  provider         text not null check (provider in ('internal','meta','ga4','google_ads')),
  payment_id       uuid,
  payload          jsonb not null default '{}'::jsonb,   -- already allowlisted; never raw rows
  status           text not null default 'pending'
                   check (status in ('pending','processing','sent','failed','dead_letter','skipped')),
  attempt_count    int not null default 0,
  next_retry_at    timestamptz not null default now(),
  locked_until     timestamptz,
  last_http_status int,
  last_error       text,
  created_at       timestamptz not null default now(),
  processed_at     timestamptz,
  unique (provider, event_name, event_id)
);
create index if not exists analytics_outbox_due_idx on analytics_outbox (status, next_retry_at);

-- Razorpay payments only: record-only / admin-created / cash rows never count.
create or replace function analytics_enqueue_payment() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  online boolean := new.razorpay_payment_id is not null
                    and coalesce(new.admin_created, false) = false
                    and coalesce(new.record_only, false) = false;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;
  if new.status = 'success' and online then
    insert into analytics_outbox (event_id, event_name, provider, payment_id)
    values ('purchase_' || new.id, 'payment_completed', 'internal', new.id)
    on conflict (provider, event_name, event_id) do nothing;
  elsif new.status = 'refunded' and new.razorpay_payment_id is not null then
    insert into analytics_outbox (event_id, event_name, provider, payment_id)
    values ('refund_' || new.id, 'booking_cancelled', 'internal', new.id)
    on conflict (provider, event_name, event_id) do nothing;
  elsif new.status = 'failed' and new.razorpay_order_id is not null then
    insert into analytics_outbox (event_id, event_name, provider, payment_id)
    values ('payfail_' || new.id, 'payment_failed', 'internal', new.id)
    on conflict (provider, event_name, event_id) do nothing;
  end if;
  return new;
exception when others then
  -- analytics must never break a payment
  raise warning 'analytics_enqueue_payment skipped: %', sqlerrm;
  return new;
end $$;

drop trigger if exists payments_analytics_enqueue on payments;
create trigger payments_analytics_enqueue
  after insert or update of status on payments
  for each row execute function analytics_enqueue_payment();

-- Claim a batch for the worker. SKIP LOCKED: a second Render instance never
-- takes the same rows; a row stuck in 'processing' is reclaimed after 5 min.
create or replace function analytics_claim_outbox(batch int default 50)
returns setof analytics_outbox
language sql security definer set search_path = public as $$
  update analytics_outbox o
     set status = 'processing',
         locked_until = now() + interval '5 minutes',
         attempt_count = o.attempt_count + 1
   where o.id in (
     select id from analytics_outbox
      where (status in ('pending','failed') and next_retry_at <= now())
         or (status = 'processing' and locked_until < now())
      order by created_at
      for update skip locked
      limit greatest(1, least(batch, 500)))
  returning o.*;
$$;

-- first/last touch upsert in one statement (first_* only on insert; last_* only for non-direct arrivals)
create or replace function analytics_touch_visitor(
  p_anonymous_id uuid, p_env text, p_channel text, p_source text, p_medium text, p_campaign text,
  p_landing_group text, p_referrer_host text, p_fbclid text, p_gclid text, p_gbraid text, p_wbraid text,
  p_first_channel text, p_first_source text, p_first_medium text, p_first_campaign text
) returns void
language sql security definer set search_path = public as $$
  insert into visitor_attribution as v (
    anonymous_id, environment,
    first_channel, first_source, first_medium, first_campaign, first_landing_group, first_referrer_host,
    last_channel, last_source, last_medium, last_campaign, fbclid, gclid, gbraid, wbraid)
  values (
    p_anonymous_id, p_env,
    coalesce(p_first_channel, p_channel), coalesce(p_first_source, p_source), coalesce(p_first_medium, p_medium),
    coalesce(p_first_campaign, p_campaign), p_landing_group, p_referrer_host,
    p_channel, p_source, p_medium, p_campaign, p_fbclid, p_gclid, p_gbraid, p_wbraid)
  on conflict (anonymous_id) do update set
    last_seen_at   = now(),
    last_channel   = case when excluded.last_channel is not null and excluded.last_channel <> 'direct' then excluded.last_channel   else v.last_channel end,
    last_source    = case when excluded.last_channel is not null and excluded.last_channel <> 'direct' then excluded.last_source    else v.last_source end,
    last_medium    = case when excluded.last_channel is not null and excluded.last_channel <> 'direct' then excluded.last_medium    else v.last_medium end,
    last_campaign  = case when excluded.last_channel is not null and excluded.last_channel <> 'direct' then excluded.last_campaign  else v.last_campaign end,
    fbclid = coalesce(excluded.fbclid, v.fbclid),
    gclid  = coalesce(excluded.gclid,  v.gclid),
    gbraid = coalesce(excluded.gbraid, v.gbraid),
    wbraid = coalesce(excluded.wbraid, v.wbraid);
$$;

-- ---------------------------------------------------------------------------
-- Reporting: one aggregate function the marketing API composes every page
-- from. Dimensions are a fixed whitelist (no free SQL); results are counts
-- and sums only — never rows about a person.
-- ---------------------------------------------------------------------------
create or replace function mkt_event_counts(
  p_from     date,
  p_to       date,                 -- inclusive, IST
  p_env      text,
  p_events   text[] default null,  -- null = all events
  p_dims     text[] default '{}',
  p_channel  text   default null,
  p_device   text   default null,
  p_model    text   default 'last',
  p_limit    int    default 500
) returns table (dims jsonb, events bigint, visitors bigint, sessions bigint, value numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  chcol text := case when p_model = 'first' then 'coalesce(e.first_channel, e.channel)' else 'e.channel' end;
  sel   text[] := '{}';
  d     text;
  expr  text;
begin
  foreach d in array coalesce(p_dims, '{}') loop
    expr := case d
      when 'event_name'    then 'e.event_name'
      when 'day'           then '((e.occurred_at at time zone ''Asia/Kolkata'')::date)::text'
      when 'hour'          then 'extract(hour from e.occurred_at at time zone ''Asia/Kolkata'')::int::text'
      when 'channel'       then chcol
      when 'utm_source'    then 'e.utm_source'
      when 'utm_medium'    then 'e.utm_medium'
      when 'utm_campaign'  then 'e.utm_campaign'
      when 'page_group'    then 'e.page_group'
      when 'page_topic'    then 'e.page_topic'
      when 'landing_group' then 'e.landing_group'
      when 'landing_topic' then 'e.landing_topic'
      when 'device_class'  then 'e.device_class'
      when 'region'        then 'e.region'
      when 'psychologist_id' then 'e.psychologist_id::text'
      when 'element'       then 'e.props->>''element'''
      when 'popup'         then 'e.props->>''popup'''
      when 'action'        then 'e.props->>''action'''
      when 'step'          then 'e.props->>''step'''
      when 'code'          then 'e.props->>''code'''
      when 'filter'        then 'e.props->>''filter'''
      when 'filter_value'  then 'e.props->>''value'''
      when 'depth'         then 'e.props->>''depth'''
      when 'item_kind'     then 'e.props->>''item_kind'''
      when 'kind'          then 'e.props->>''kind'''
      when 'method'        then 'e.props->>''method'''
      when 'returning'     then 'e.props->>''returning'''
      else null end;
    if expr is null then
      raise exception 'dimension not allowed: %', d;
    end if;
    sel := sel || format('%L, %s', d, expr);
  end loop;

  return query execute format(
    'select %s as dims,
            count(*)::bigint,
            count(distinct e.anonymous_id)::bigint,
            count(distinct e.session_id)::bigint,
            coalesce(sum(e.value), 0)::numeric
       from analytics_events e
      where e.environment = $1
        and e.occurred_at >= ($2::timestamp at time zone ''Asia/Kolkata'')
        and e.occurred_at <  (($3 + 1)::timestamp at time zone ''Asia/Kolkata'')
        and not e.is_bot
        and ($4::text[] is null or e.event_name = any($4))
        and ($5::text is null or %s = $5)
        and ($6::text is null or e.device_class = $6)
      group by 1
      order by 2 desc
      limit $7',
    case when coalesce(array_length(sel, 1), 0) = 0 then '''{}''::jsonb'
         else 'jsonb_build_object(' || array_to_string(sel, ', ') || ')' end,
    chcol)
  using p_env, p_from, p_to, p_events, p_channel, p_device, greatest(1, least(p_limit, 5000));
end $$;

-- ---------------------------------------------------------------------------
-- Security: RLS on, no policies → only the backend's service role can touch
-- these. The functions are not callable by anon/authenticated through the
-- public API.
-- ---------------------------------------------------------------------------
alter table analytics_events     enable row level security;
alter table analytics_identities enable row level security;
alter table visitor_attribution  enable row level security;
alter table booking_attribution  enable row level security;
alter table lead_attribution     enable row level security;
alter table consent_records      enable row level security;
alter table analytics_outbox     enable row level security;

revoke all on function analytics_enqueue_payment()                    from public, anon, authenticated;
revoke all on function analytics_claim_outbox(int)                    from public, anon, authenticated;
revoke all on function analytics_touch_visitor(uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text) from public, anon, authenticated;
revoke all on function mkt_event_counts(date,date,text,text[],text[],text,text,text,int) from public, anon, authenticated;
grant execute on function analytics_claim_outbox(int)                 to service_role;
grant execute on function analytics_touch_visitor(uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text) to service_role;
grant execute on function mkt_event_counts(date,date,text,text[],text[],text,text,text,int) to service_role;

-- ============================================================================
-- ROLLBACK (run manually if needed — bookings and payments are unaffected)
--
--   drop trigger if exists payments_analytics_enqueue on payments;
--   drop function if exists analytics_enqueue_payment();
--   drop function if exists analytics_claim_outbox(int);
--   drop function if exists analytics_touch_visitor(uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text);
--   drop function if exists mkt_event_counts(date,date,text,text[],text[],text,text,text,int);
--   drop table if exists analytics_outbox, consent_records, lead_attribution,
--                        booking_attribution, visitor_attribution,
--                        analytics_identities, analytics_events;
-- ============================================================================
