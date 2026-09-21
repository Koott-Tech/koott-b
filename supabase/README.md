# Database setup

## 1. Create the schema

Open your Supabase project → **SQL Editor** → New query → paste the entire contents
of `migrations/0001_initial_schema.sql` → **Run**. Then do the same with
`migrations/0002_missing_finance_columns.sql`, then `migrations/0003_psychologist_card_intro.sql`.

42 tables, ~593 columns. Both files are safe to re-run (`if not exists` throughout).

**Run 0002 as well, not just 0001.** 0001 was built by scanning `.select('literal
string')` calls, which missed the finance controllers — they build their select list
from array constants (`FINANCE_EXPENSE_SELECT` and friends) joined with `', '`. Without
0002, the expenses, income, expense-categories and income-sources endpoints all fail.

## 2. Create the storage buckets

Storage → New bucket, one for each. All are read by the image proxy, so make them
**public** unless you plan to sign URLs:

- `profile-pictures`
- `blog-images`
- `counselling-images`
- `events-poster`
- `manual-bookings`
- `certificate-templates`

## 3. Seed a login

With `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set in `.env`:

    node scripts/seed-initial-data.js

Creates a superadmin, a therapist (with commission rates and a package) and a client,
and prints their passwords once. Set `SEED_ADMIN_PASSWORD` etc. in `.env` to pin them.
Re-running updates rather than duplicating.

## Where this schema came from

It is derived from every Supabase query in the backend and frontend — the columns are
the ones the code actually reads and writes. It is **not** a dump of the old Wix-era
database, so:

- Columns the old database had that the code never touches are absent.
- Types are inferred from usage. Money is `numeric(10,2)`, timestamps are `timestamptz`,
  loosely-shaped fields are `jsonb`. Review anything that matters before you rely on it.
- Status columns are plain `text` with no `CHECK` constraint, because the code writes a
  wide and not-fully-enumerable set of status values.

## Row Level Security

RLS is enabled on every table with **no policies**, which denies all access to the `anon`
key. This is deliberate: the backend uses the `service_role` key, which bypasses RLS, so
the API is unaffected — but the `anon` key ships to the browser, and without RLS anyone
could read these tables directly from the client.

If you later want the browser to read a table directly, add a policy for that table only.
`newsletter_subscribers` is currently written from a Next.js route handler using the
service role key, so it needs no policy.

## Known gap

`sessions.locally_modified` is vestigial — it existed only for the removed Wix sync. It
is kept because some code still writes it, and can be dropped once those writes go.
