-- 0026 — how each payment reached us, and what Razorpay kept.
--
-- payment_channel  'razorpay' — website checkout or a Razorpay payment link; Razorpay deducts its
--                               fee and settles the rest to the company account a few days later.
--                  'direct'   — UPI / bank transfer / cash straight into the company account, no fee.
-- gateway_fee      rupees Razorpay kept (fee + GST). Filled from Razorpay's payment entity on
--                  capture, or typed in for a payment link. NULL on a Razorpay payment = estimate
--                  (RAZORPAY_FEE_PERCENT, default 2.36%) until the real fee is known.
-- Existing rows are backfilled: Razorpay ids → 'razorpay', everything else → 'direct' (fee 0).

alter table payments add column if not exists payment_channel text;
alter table payments add column if not exists gateway_fee numeric(12,2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_payment_channel_check') then
    alter table payments add constraint payments_payment_channel_check
      check (payment_channel is null or payment_channel in ('razorpay', 'direct'));
  end if;
end $$;

update payments set payment_channel = 'razorpay'
 where payment_channel is null
   and (razorpay_payment_id is not null or razorpay_order_id is not null
        or lower(coalesce(provider, '')) = 'razorpay'
        or lower(coalesce(payment_method, '')) in ('razorpay', 'razorpay_link', 'payment_link'));

update payments set payment_channel = 'direct', gateway_fee = coalesce(gateway_fee, 0)
 where payment_channel is null;

-- (A NULL gateway_fee on a Razorpay row: the app reads the real fee from razorpay_response
--  when it is there, else estimates - so no risky JSON cast here.)

create index if not exists payments_payment_channel_idx on payments (payment_channel);

notify pgrst, 'reload schema';
