-- ============================================================================
-- 0012 · Marketing dashboard reports (Analytics Highlights + Traffic Overview)
--
-- Read-only reporting functions on top of 0011. No table changes.
-- Every function returns totals only — never a row about a person — and is
-- callable only by the backend's service role. Safe to re-run.
-- Times are grouped in IST (Asia/Kolkata).
-- ============================================================================

-- mkt_event_counts: same as 0011, plus two dimensions:
--   page_path  (for "Most visited pages", "Most clicked buttons", blog posts)
--   dow        (0 = Sunday … 6 = Saturday, for "Avg. sessions by day" and the blog heat map)
create or replace function mkt_event_counts(
  p_from     date,
  p_to       date,
  p_env      text,
  p_events   text[] default null,
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
      when 'dow'           then 'extract(dow from e.occurred_at at time zone ''Asia/Kolkata'')::int::text'
      when 'channel'       then chcol
      when 'utm_source'    then 'e.utm_source'
      when 'utm_medium'    then 'e.utm_medium'
      when 'utm_campaign'  then 'e.utm_campaign'
      when 'page_path'     then 'e.page_path'
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

-- Engagement stats: pages per session, average session duration, bounce rate.
-- A session's duration is first to last recorded activity; a bounce is a
-- session with a single page view.
create or replace function mkt_session_stats(p_from date, p_to date, p_env text)
returns table (sessions bigint, page_views bigint, avg_duration_seconds numeric, bounce_rate numeric)
language sql stable security definer set search_path = public as $$
  with s as (
    select e.session_id,
           count(*) filter (where e.event_name = 'page_view') as pv,
           extract(epoch from max(e.occurred_at) - min(e.occurred_at)) as dur
      from analytics_events e
     where e.environment = p_env
       and not e.is_bot
       and e.session_id is not null
       and e.occurred_at >= (p_from::timestamp at time zone 'Asia/Kolkata')
       and e.occurred_at <  ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
     group by e.session_id
    having count(*) filter (where e.event_name = 'page_view') > 0
  )
  select count(*)::bigint,
         coalesce(sum(pv), 0)::bigint,
         coalesce(round(avg(dur)::numeric, 1), 0),
         coalesce(round(avg((pv <= 1)::int)::numeric, 4), 0)
    from s;
$$;

-- New vs returning visitors: a visitor active in the range is "new" if their
-- first ever recorded activity falls inside it.
create or replace function mkt_visitor_split(p_from date, p_to date, p_env text)
returns table (new_visitors bigint, returning_visitors bigint)
language sql stable security definer set search_path = public as $$
  with active as (
    select distinct e.anonymous_id
      from analytics_events e
     where e.environment = p_env and not e.is_bot and e.anonymous_id is not null
       and e.occurred_at >= (p_from::timestamp at time zone 'Asia/Kolkata')
       and e.occurred_at <  ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
  ), firsts as (
    select e.anonymous_id, min(e.occurred_at) as first_at
      from analytics_events e
      join active a on a.anonymous_id = e.anonymous_id
     where e.environment = p_env
     group by e.anonymous_id
  )
  select count(*) filter (where first_at >= (p_from::timestamp at time zone 'Asia/Kolkata'))::bigint,
         count(*) filter (where first_at <  (p_from::timestamp at time zone 'Asia/Kolkata'))::bigint
    from firsts;
$$;

-- Per-page engagement for a path prefix (blog posts): views, sessions, clicks
-- on the page, and average time on page (from page_engaged seconds).
create or replace function mkt_path_engagement(p_from date, p_to date, p_env text, p_prefix text)
returns table (page_path text, views bigint, sessions bigint, clicks bigint, avg_seconds numeric)
language sql stable security definer set search_path = public as $$
  select e.page_path,
         count(*) filter (where e.event_name = 'page_view')::bigint,
         count(distinct e.session_id) filter (where e.event_name = 'page_view')::bigint,
         count(*) filter (where e.event_name = 'ui_click')::bigint,
         coalesce(round(avg((e.props->>'seconds')::numeric) filter (where e.event_name = 'page_engaged'), 0), 0)
    from analytics_events e
   where e.environment = p_env and not e.is_bot
     and e.page_path like (p_prefix || '%')
     and e.occurred_at >= (p_from::timestamp at time zone 'Asia/Kolkata')
     and e.occurred_at <  ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
   group by e.page_path;
$$;

-- Sales from the payments table (the source of truth, independent of cookie
-- consent): verified online Razorpay payments only — not cash, admin-created
-- or record-only rows. p_group: 'total' | 'day' | 'psychologist' | 'source'.
create or replace function mkt_sales(p_from date, p_to date, p_group text default 'total')
returns table (key text, orders bigint, revenue numeric)
language sql stable security definer set search_path = public as $$
  select case p_group
           when 'day' then ((coalesce(p.completed_at, p.paid_at, p.created_at) at time zone 'Asia/Kolkata')::date)::text
           when 'psychologist' then p.psychologist_id::text
           when 'source' then coalesce(ba.last_channel, 'unattributed') || '|' || coalesce(ba.last_source, '')
           else 'total' end as key,
         count(*)::bigint,
         coalesce(sum(p.amount), 0)::numeric
    from payments p
    left join booking_attribution ba on ba.payment_id = p.id
   where p.status = 'success'
     and p.razorpay_payment_id is not null
     and coalesce(p.admin_created, false) = false
     and coalesce(p.record_only, false) = false
     and coalesce(p.completed_at, p.paid_at, p.created_at) >= (p_from::timestamp at time zone 'Asia/Kolkata')
     and coalesce(p.completed_at, p.paid_at, p.created_at) <  ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
   group by 1;
$$;

-- Bookings: sessions booked in the range (any source — website, package,
-- admin), cancelled ones excluded. p_group: 'total' | 'day'.
create or replace function mkt_bookings(p_from date, p_to date, p_group text default 'total')
returns table (key text, bookings bigint)
language sql stable security definer set search_path = public as $$
  select case p_group
           when 'day' then ((coalesce(s.booking_created_at, s.created_at) at time zone 'Asia/Kolkata')::date)::text
           else 'total' end,
         count(*)::bigint
    from sessions s
   where coalesce(s.status, '') not in ('cancelled', 'canceled')
     and coalesce(s.booking_created_at, s.created_at) >= (p_from::timestamp at time zone 'Asia/Kolkata')
     and coalesce(s.booking_created_at, s.created_at) <  ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
   group by 1;
$$;

revoke all on function mkt_event_counts(date,date,text,text[],text[],text,text,text,int) from public, anon, authenticated;
revoke all on function mkt_session_stats(date,date,text)        from public, anon, authenticated;
revoke all on function mkt_visitor_split(date,date,text)        from public, anon, authenticated;
revoke all on function mkt_path_engagement(date,date,text,text) from public, anon, authenticated;
revoke all on function mkt_sales(date,date,text)                from public, anon, authenticated;
revoke all on function mkt_bookings(date,date,text)             from public, anon, authenticated;
grant execute on function mkt_event_counts(date,date,text,text[],text[],text,text,text,int) to service_role;
grant execute on function mkt_session_stats(date,date,text)        to service_role;
grant execute on function mkt_visitor_split(date,date,text)        to service_role;
grant execute on function mkt_path_engagement(date,date,text,text) to service_role;
grant execute on function mkt_sales(date,date,text)                to service_role;
grant execute on function mkt_bookings(date,date,text)             to service_role;

-- ROLLBACK: drop the five new functions; re-run 0011 to restore the original mkt_event_counts.
--   drop function if exists mkt_session_stats(date,date,text), mkt_visitor_split(date,date,text),
--     mkt_path_engagement(date,date,text,text), mkt_sales(date,date,text), mkt_bookings(date,date,text);
