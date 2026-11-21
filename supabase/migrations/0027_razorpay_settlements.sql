-- 0027 - Razorpay settlements recorded as expenses.
--
-- When Razorpay pays out to the company bank account (every few days, not fixed), Finance
-- records one settlement: what Razorpay collected for us (gross) and what reached the bank
-- (received). The difference is Razorpay's fee + GST, saved as an expense in the
-- "Razorpay fees" category, so net profit counts it like any other expense.
-- "Still with Razorpay" on the dashboard = Razorpay payments collected - settled gross.

alter table expenses add column if not exists settlement_gross    numeric(12,2);
alter table expenses add column if not exists settlement_received numeric(12,2);

insert into expense_categories (name, is_active)
values ('Razorpay fees', true)
on conflict (name) do update set is_active = true;

notify pgrst, 'reload schema';
