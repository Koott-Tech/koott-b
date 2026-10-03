-- ============================================================================
-- 0002 — columns the finance controllers select but 0001 did not create.
--
-- 0001 was built by scanning .select('literal string') calls. These controllers
-- instead build their select list from an array constant joined with ', '
-- (FINANCE_EXPENSE_SELECT and friends), which that scan did not see. Found by
-- probing the live database column by column.
--
-- Safe to re-run.
-- ============================================================================

-- Expenses ------------------------------------------------------------------
alter table expenses add column if not exists payment_method      text;
alter table expenses add column if not exists vendor_supplier     text;
alter table expenses add column if not exists receipt_url         text;
alter table expenses add column if not exists reference_number    text;
alter table expenses add column if not exists notes               text;
alter table expenses add column if not exists is_recurring        boolean default false;
alter table expenses add column if not exists recurring_frequency text;

-- Income --------------------------------------------------------------------
alter table income_entries add column if not exists income_source    text;
alter table income_entries add column if not exists payment_method   text;
alter table income_entries add column if not exists reference_number text;
alter table income_entries add column if not exists notes            text;

-- Finance reference data ----------------------------------------------------
alter table expense_categories add column if not exists description text;
alter table income_sources     add column if not exists description text;

-- Payments and receipts -----------------------------------------------------
alter table payments add column if not exists reference_number    text;
alter table receipts add column if not exists receipt_url         text;
alter table receipts add column if not exists receipt_number_long text;

-- Monthly finance snapshot --------------------------------------------------
-- Written by monthlyFinanceSnapshotService; the dashboard reads them back.
alter table monthly_finance_dashboard add column if not exists total_revenue                 numeric(12,2) default 0;
alter table monthly_finance_dashboard add column if not exists total_expenses                numeric(12,2) default 0;
alter table monthly_finance_dashboard add column if not exists net_profit                    numeric(12,2) default 0;
alter table monthly_finance_dashboard add column if not exists pending_payout                numeric(12,2) default 0;
alter table monthly_finance_dashboard add column if not exists payout_received               numeric(12,2) default 0;
alter table monthly_finance_dashboard add column if not exists total_company_commission      numeric(12,2) default 0;
alter table monthly_finance_dashboard add column if not exists total_doctor_wallet           numeric(12,2) default 0;
alter table monthly_finance_dashboard add column if not exists refund_total                  numeric(12,2) default 0;
alter table monthly_finance_dashboard add column if not exists total_sessions                integer default 0;
alter table monthly_finance_dashboard add column if not exists pending_sessions              integer default 0;
alter table monthly_finance_dashboard add column if not exists completed_sessions            integer default 0;
alter table monthly_finance_dashboard add column if not exists rescheduled_sessions          integer default 0;
alter table monthly_finance_dashboard add column if not exists reschedule_requested_sessions integer default 0;
alter table monthly_finance_dashboard add column if not exists no_show_sessions              integer default 0;
alter table monthly_finance_dashboard add column if not exists upcoming_sessions             integer default 0;
alter table monthly_finance_dashboard add column if not exists active_doctors                integer default 0;
