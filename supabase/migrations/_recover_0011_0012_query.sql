-- Recovering migrations 0011 and 0012.
--
-- Both were applied to the database but their files are not in the repo (*.sql
-- was ignored, see .gitignore). This query prints the schema they created so it
-- can be written back into supabase/migrations/. Run it in the Supabase SQL
-- editor and save the output.

-- 1. The reporting functions, in full.
select pg_get_functiondef(p.oid) || ';' as ddl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'mkt\_%'
order by p.proname;

-- 2. The analytics tables' columns.
select table_name, ordinal_position, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('analytics_events','analytics_identities','analytics_outbox',
                     'booking_attribution','lead_attribution','consent_records')
order by table_name, ordinal_position;

-- 3. Their indexes and constraints.
select tablename, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in ('analytics_events','analytics_identities','analytics_outbox',
                    'booking_attribution','lead_attribution','consent_records')
order by tablename, indexname;

-- 4. The trigger on payments that feeds the outbox.
select tgname, pg_get_triggerdef(t.oid) || ';' as ddl
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where c.relname = 'payments' and not t.tgisinternal;
