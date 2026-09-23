-- 0013 — reporting functions the detailed marketing reports need.
--
-- controllers/marketingController.js calls both of these. Without them Top
-- Traffic Sources answers 503 NOT_MIGRATED and the blog engagement numbers on
-- Analytics Highlights stay at zero.
--
-- Both read analytics_events only, return aggregates only, and follow the same
-- conventions as 0011/0012: IST day boundaries (a day runs 00:00–24:00
-- Asia/Kolkata), bots excluded, one environment at a time.
--
-- Rollback is at the bottom.

-- ---------------------------------------------------------------- source stats
--
-- Sessions and visitors by traffic source under one of five attribution models:
--
--   last                     the session's own first touch
--   first                    the visitor's earliest touch we have seen
--   last_non_direct          the visitor's most recent non-direct touch at or
--                            before the session started; the session's own
--                            touch when there is none
--   last_non_direct_facebook as last_non_direct, but a session still landing on
--   last_non_direct_google   direct/unknown is credited to that platform when
--                            the visitor has any touch from it in the window
--
-- The lookback is the reporting window itself: a touch before `p_from` cannot
-- be seen. Say so in the report rather than implying a full visitor history.
create or replace function mkt_source_stats(
  p_from date,
  p_to date,
  p_env text default 'production',
  p_model text default 'last_non_direct',
  p_split text default null
)
returns table (channel text, source text, sessions bigint, visitors bigint, split text)
language sql
stable
security definer
set search_path = public
as $$
  with ev as (
    select session_id, anonymous_id, occurred_at, channel, utm_source, device_class
    from analytics_events
    where environment = p_env
      and coalesce(is_bot, false) = false
      and session_id is not null
      and occurred_at >= (p_from::timestamp at time zone 'Asia/Kolkata')
      and occurred_at <  ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
  ),
  -- one row per session: the touch it arrived on
  sess as (
    select distinct on (session_id)
      session_id, anonymous_id, occurred_at, channel, utm_source, device_class
    from ev
    order by session_id, occurred_at
  ),
  -- every non-direct touch, for the last-non-direct models
  nd as (
    select anonymous_id, occurred_at, channel, utm_source
    from ev
    where channel is not null and channel <> 'direct'
  ),
  resolved as (
    select
      s.session_id,
      s.anonymous_id,
      s.device_class,
      case
        when p_model = 'last' then s.channel
        when p_model = 'first' then coalesce(f.channel, s.channel)
        else coalesce(n.channel, s.channel)
      end as channel,
      case
        when p_model = 'last' then s.utm_source
        when p_model = 'first' then coalesce(f.utm_source, s.utm_source)
        else coalesce(n.utm_source, s.utm_source)
      end as source
    from sess s
    left join lateral (
      select channel, utm_source
      from ev
      where ev.anonymous_id = s.anonymous_id
      order by ev.occurred_at asc
      limit 1
    ) f on p_model = 'first'
    left join lateral (
      select channel, utm_source
      from nd
      where nd.anonymous_id = s.anonymous_id
        and nd.occurred_at <= s.occurred_at
      order by nd.occurred_at desc
      limit 1
    ) n on p_model like 'last\_non\_direct%'
  ),
  -- the two platform variants: a session still on direct/unknown goes to the
  -- platform when that visitor touched it at all inside the window
  platform as (
    select r.*,
      case
        when p_model not like '%facebook' and p_model not like '%google' then null
        when r.channel is not null and r.channel <> 'direct' then null
        else (
          select x.channel
          from ev x
          where x.anonymous_id = r.anonymous_id
            and x.channel is not null and x.channel <> 'direct'
            and (
              (p_model like '%facebook' and (x.utm_source ilike '%facebook%' or x.utm_source ilike '%instagram%' or x.utm_source ilike '%fb%'))
              or (p_model like '%google' and x.utm_source ilike '%google%')
            )
          order by x.occurred_at desc
          limit 1
        )
      end as claimed_channel,
      case
        when p_model not like '%facebook' and p_model not like '%google' then null
        when r.channel is not null and r.channel <> 'direct' then null
        else (
          select x.utm_source
          from ev x
          where x.anonymous_id = r.anonymous_id
            and x.channel is not null and x.channel <> 'direct'
            and (
              (p_model like '%facebook' and (x.utm_source ilike '%facebook%' or x.utm_source ilike '%instagram%' or x.utm_source ilike '%fb%'))
              or (p_model like '%google' and x.utm_source ilike '%google%')
            )
          order by x.occurred_at desc
          limit 1
        )
      end as claimed_source
    from resolved r
  )
  select
    coalesce(claimed_channel, channel) as channel,
    coalesce(claimed_source, source) as source,
    count(distinct session_id)::bigint as sessions,
    count(distinct anonymous_id)::bigint as visitors,
    case when p_split = 'device' then coalesce(device_class, 'unknown') else null end as split
  from platform
  group by 1, 2, 5
  order by sessions desc;
$$;

-- ------------------------------------------------------------ path engagement
--
-- Views, tagged clicks and average engaged seconds for every page under a path
-- prefix — the blog numbers on Analytics Highlights (`/blog/`).
--
-- avg_seconds is the mean of the page_engaged events recorded for that page, so
-- it is time the tab was actually open and visible, not time between page
-- views. Pages with no page_engaged event report 0, not null.
create or replace function mkt_path_engagement(
  p_from date,
  p_to date,
  p_env text default 'production',
  p_prefix text default ''
)
returns table (page_path text, views bigint, clicks bigint, avg_seconds numeric)
language sql
stable
security definer
set search_path = public
as $$
  with ev as (
    select event_name, page_path, props
    from analytics_events
    where environment = p_env
      and coalesce(is_bot, false) = false
      and page_path is not null
      and (p_prefix = '' or page_path like p_prefix || '%')
      and occurred_at >= (p_from::timestamp at time zone 'Asia/Kolkata')
      and occurred_at <  ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
  )
  select
    page_path,
    count(*) filter (where event_name = 'page_view')::bigint as views,
    count(*) filter (where event_name = 'ui_click')::bigint as clicks,
    coalesce(
      avg((props ->> 'seconds')::numeric) filter (
        where event_name = 'page_engaged' and (props ->> 'seconds') ~ '^[0-9]+$'
      ),
      0
    )::numeric as avg_seconds
  from ev
  group by page_path
  having count(*) filter (where event_name = 'page_view') > 0
  order by views desc;
$$;

grant execute on function mkt_source_stats(date, date, text, text, text) to service_role;
grant execute on function mkt_path_engagement(date, date, text, text) to service_role;

-- Rollback:
-- drop function if exists mkt_source_stats(date, date, text, text, text);
-- drop function if exists mkt_path_engagement(date, date, text, text);

-- ------------------------------------------------------------- booking funnel
--
-- The funnel Koott actually has, in order. Every step is an event the site
-- already sends (analytics/registry.js), except the last: booking_completed is
-- written by the payments trigger from a verified Razorpay payment, never by a
-- browser.
--
--   1 counsellor_list_view     the listing
--   2 counsellor_profile_view  a therapist's profile
--   3 booking_started          the booking flow opened
--   4 phone_verified           the WhatsApp code checked out
--   5 slot_selected            a date and time chosen
--   6 plan_selected            single session or package
--   7 details_completed        "About yourself" submitted
--   8 checkout_started         the order created
--   9 payment_opened           Razorpay opened
--  10 booking_completed        payment verified on the server
--
-- Steps are counted by session: a session that did a step twice counts once.
-- Sessions are not required to pass through every step, so a later step can
-- hold sessions that skipped an earlier one — read each step as "reached", not
-- "reached in sequence".
create or replace function mkt_funnel_step_order(p_event text)
returns int
language sql
immutable
as $$
  select case p_event
    when 'counsellor_list_view' then 1
    when 'counsellor_profile_view' then 2
    when 'booking_started' then 3
    when 'phone_verified' then 4
    when 'slot_selected' then 5
    when 'plan_selected' then 6
    when 'details_completed' then 7
    when 'checkout_started' then 8
    when 'payment_opened' then 9
    when 'booking_completed' then 10
    else null end;
$$;

create or replace function mkt_funnel(
  p_from date,
  p_to date,
  p_env text default 'production',
  p_channel text default null,
  p_device text default null,
  p_psychologist uuid default null
)
returns table (step text, step_order int, sessions bigint, visitors bigint)
language sql
stable
security definer
set search_path = public
as $$
  with ev as (
    select event_name, session_id, anonymous_id
    from analytics_events
    where environment = p_env
      and coalesce(is_bot, false) = false
      and session_id is not null
      and mkt_funnel_step_order(event_name) is not null
      and (p_channel is null or channel = p_channel)
      and (p_device is null or device_class = p_device)
      and (p_psychologist is null or psychologist_id = p_psychologist)
      and occurred_at >= (p_from::timestamp at time zone 'Asia/Kolkata')
      and occurred_at <  ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
  )
  select
    event_name as step,
    mkt_funnel_step_order(event_name) as step_order,
    count(distinct session_id)::bigint as sessions,
    count(distinct anonymous_id)::bigint as visitors
  from ev
  group by 1, 2
  order by 2;
$$;

-- Where sessions stopped: the furthest step each session reached, counted once.
-- Only sessions that entered the flow (booking_started or later) are included,
-- so browsing the listing is not called an abandoned booking.
create or replace function mkt_funnel_dropoff(
  p_from date,
  p_to date,
  p_env text default 'production',
  p_channel text default null,
  p_device text default null,
  p_psychologist uuid default null
)
returns table (step text, step_order int, sessions bigint)
language sql
stable
security definer
set search_path = public
as $$
  with ev as (
    select session_id, max(mkt_funnel_step_order(event_name)) as furthest
    from analytics_events
    where environment = p_env
      and coalesce(is_bot, false) = false
      and session_id is not null
      and mkt_funnel_step_order(event_name) is not null
      and (p_channel is null or channel = p_channel)
      and (p_device is null or device_class = p_device)
      and (p_psychologist is null or psychologist_id = p_psychologist)
      and occurred_at >= (p_from::timestamp at time zone 'Asia/Kolkata')
      and occurred_at <  ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
    group by session_id
    having max(mkt_funnel_step_order(event_name)) >= 3
  )
  select
    case furthest
      when 3 then 'booking_started'
      when 4 then 'phone_verified'
      when 5 then 'slot_selected'
      when 6 then 'plan_selected'
      when 7 then 'details_completed'
      when 8 then 'checkout_started'
      when 9 then 'payment_opened'
      when 10 then 'booking_completed'
    end as step,
    furthest as step_order,
    count(*)::bigint as sessions
  from ev
  group by 1, 2
  order by 2;
$$;

-- --------------------------------------------------------- therapist activity
--
-- Per therapist: what visitors did on the way to booking them. Views and clicks
-- come from events (psychologist_id is set on profile and booking events);
-- bookings and revenue are read straight from payments, which is the only place
-- money is settled.
create or replace function mkt_therapist_stats(
  p_from date,
  p_to date,
  p_env text default 'production'
)
returns table (
  psychologist_id uuid,
  profile_views bigint,
  visitors bigint,
  booking_started bigint,
  checkout_started bigint,
  bookings bigint,
  revenue numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with ev as (
    select event_name, psychologist_id, session_id, anonymous_id
    from analytics_events
    where environment = p_env
      and coalesce(is_bot, false) = false
      and psychologist_id is not null
      and occurred_at >= (p_from::timestamp at time zone 'Asia/Kolkata')
      and occurred_at <  ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
  ),
  acts as (
    select
      psychologist_id,
      count(*) filter (where event_name = 'counsellor_profile_view')::bigint as profile_views,
      count(distinct anonymous_id)::bigint as visitors,
      count(distinct session_id) filter (where event_name = 'booking_started')::bigint as booking_started,
      count(distinct session_id) filter (where event_name = 'checkout_started')::bigint as checkout_started
    from ev
    group by psychologist_id
  ),
  paid as (
    select s.psychologist_id,
           count(*)::bigint as bookings,
           coalesce(sum(p.amount), 0)::numeric as revenue
    from payments p
    join sessions s on s.id = p.session_id
    where p.status = 'success'
      and p.created_at >= (p_from::timestamp at time zone 'Asia/Kolkata')
      and p.created_at <  ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
    group by s.psychologist_id
  )
  select
    coalesce(a.psychologist_id, b.psychologist_id) as psychologist_id,
    coalesce(a.profile_views, 0), coalesce(a.visitors, 0),
    coalesce(a.booking_started, 0), coalesce(a.checkout_started, 0),
    coalesce(b.bookings, 0), coalesce(b.revenue, 0)
  from acts a
  full outer join paid b on b.psychologist_id = a.psychologist_id
  order by 6 desc, 2 desc;
$$;

grant execute on function mkt_funnel(date, date, text, text, text, uuid) to service_role;
grant execute on function mkt_funnel_dropoff(date, date, text, text, text, uuid) to service_role;
grant execute on function mkt_therapist_stats(date, date, text) to service_role;

-- Rollback for this block:
-- drop function if exists mkt_therapist_stats(date, date, text);
-- drop function if exists mkt_funnel_dropoff(date, date, text, text, text, uuid);
-- drop function if exists mkt_funnel(date, date, text, text, text, uuid);
-- drop function if exists mkt_funnel_step_order(text);

-- ---------------------------------------------------------- session explorer
--
-- One row per session for Visitor Journeys: how it arrived, what it saw, how
-- far it got. No names, emails or phone numbers — analytics_events holds none.
-- The session id is the join key for the timeline, which is read straight from
-- analytics_events for that one session.
--
-- p_stage filters by the furthest funnel step reached (mkt_funnel_step_order),
-- so "3" means every session that opened the booking flow or went further.
create or replace function mkt_sessions(
  p_from date,
  p_to date,
  p_env text default 'production',
  p_channel text default null,
  p_device text default null,
  p_stage int default null,
  p_booked boolean default null,
  p_limit int default 100,
  p_offset int default 0
)
returns table (
  session_id uuid,
  anonymous_id uuid,
  started_at timestamptz,
  ended_at timestamptz,
  events bigint,
  page_views bigint,
  landing_path text,
  last_path text,
  channel text,
  utm_source text,
  utm_campaign text,
  device_class text,
  region text,
  furthest int,
  booked boolean,
  total bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with ev as (
    select *
    from analytics_events
    where environment = p_env
      and coalesce(is_bot, false) = false
      and session_id is not null
      and occurred_at >= (p_from::timestamp at time zone 'Asia/Kolkata')
      and occurred_at <  ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
  ),
  agg as (
    select
      session_id,
      min(anonymous_id::text)::uuid as anonymous_id,
      min(occurred_at) as started_at,
      max(occurred_at) as ended_at,
      count(*)::bigint as events,
      count(*) filter (where event_name = 'page_view')::bigint as page_views,
      (array_agg(page_path order by occurred_at asc) filter (where page_path is not null))[1] as landing_path,
      (array_agg(page_path order by occurred_at desc) filter (where page_path is not null))[1] as last_path,
      (array_agg(channel order by occurred_at asc) filter (where channel is not null))[1] as channel,
      (array_agg(utm_source order by occurred_at asc) filter (where utm_source is not null))[1] as utm_source,
      (array_agg(utm_campaign order by occurred_at asc) filter (where utm_campaign is not null))[1] as utm_campaign,
      (array_agg(device_class order by occurred_at asc) filter (where device_class is not null))[1] as device_class,
      (array_agg(region order by occurred_at asc) filter (where region is not null))[1] as region,
      coalesce(max(mkt_funnel_step_order(event_name)), 0) as furthest,
      bool_or(event_name = 'booking_completed') as booked
    from ev
    group by session_id
  ),
  filtered as (
    select * from agg
    where (p_channel is null or channel = p_channel)
      and (p_device is null or device_class = p_device)
      and (p_stage is null or furthest >= p_stage)
      and (p_booked is null or booked = p_booked)
  )
  select f.*, (select count(*) from filtered)::bigint as total
  from filtered f
  order by started_at desc
  limit greatest(1, least(coalesce(p_limit, 100), 500))
  offset greatest(0, coalesce(p_offset, 0));
$$;

grant execute on function mkt_sessions(date, date, text, text, text, int, boolean, int, int) to service_role;

-- Rollback:
-- drop function if exists mkt_sessions(date, date, text, text, text, int, boolean, int, int);

-- ------------------------------------------------------- core web vitals
--
-- Percentiles for the `web_vital` events the browser sends (frontend
-- src/analytics/vitals.js). Grouped by page group and device, because a phone
-- on a listing page and a laptop on the home page are not the same experience.
--
-- p75 is the number Google grades on. CLS arrives multiplied by 1000 so it can
-- travel as an integer; the report divides it back.
create or replace function mkt_vitals(
  p_from date,
  p_to date,
  p_env text default 'production',
  p_group text default null
)
returns table (
  metric text,
  page_group text,
  device_class text,
  samples bigint,
  p50 numeric,
  p75 numeric,
  p95 numeric,
  good bigint,
  needs_improvement bigint,
  poor bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with ev as (
    select
      props ->> 'metric' as metric,
      coalesce(page_group, 'other') as page_group,
      coalesce(device_class, 'unknown') as device_class,
      (props ->> 'value')::numeric as value,
      props ->> 'rating' as rating
    from analytics_events
    where environment = p_env
      and coalesce(is_bot, false) = false
      and event_name = 'web_vital'
      and props ? 'metric'
      and (props ->> 'value') ~ '^[0-9]+$'
      and (p_group is null or page_group = p_group)
      and occurred_at >= (p_from::timestamp at time zone 'Asia/Kolkata')
      and occurred_at <  ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
  )
  select
    metric,
    page_group,
    device_class,
    count(*)::bigint as samples,
    percentile_cont(0.50) within group (order by value)::numeric as p50,
    percentile_cont(0.75) within group (order by value)::numeric as p75,
    percentile_cont(0.95) within group (order by value)::numeric as p95,
    count(*) filter (where rating = 'good')::bigint as good,
    count(*) filter (where rating = 'needs-improvement')::bigint as needs_improvement,
    count(*) filter (where rating = 'poor')::bigint as poor
  from ev
  group by 1, 2, 3
  order by samples desc;
$$;

grant execute on function mkt_vitals(date, date, text, text) to service_role;

-- Rollback:
-- drop function if exists mkt_vitals(date, date, text, text);
