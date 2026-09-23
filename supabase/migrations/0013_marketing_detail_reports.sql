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
