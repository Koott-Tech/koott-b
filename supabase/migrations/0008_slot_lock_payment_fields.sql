-- slot_locks: payment fields written by slotLockService.updateSlotLockStatus
-- (PAYMENT_SUCCESS). Without them that update fails with PGRST204 and the lock
-- skips the PAYMENT_SUCCESS state. Safe to run more than once.
alter table slot_locks add column if not exists payment_id text;
alter table slot_locks add column if not exists signature  text;

notify pgrst, 'reload schema';
