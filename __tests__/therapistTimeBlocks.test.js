/**
 * Therapist time blocks: the two shapes, and the arithmetic behind them.
 *
 * A slot that should disappear from booking but does not is a double booking,
 * so the filtering is pinned here rather than left to a manual check.
 */

jest.mock('../config/supabase', () => ({ supabaseAdmin: {} }));

const {
  filterSlotsByRecurringBlocks,
  isSlotBlockedByRecurring,
  normalizeSlotTime,
} = require('../utils/recurringBlocksHelper');
const { normalizeTimeSlotsForStorage, isSlotBlockedByDate } = require('../utils/dateBlocksHelper');
const TimeBlockingService = require('../utils/timeBlockingService').constructor;

// 2026-11-03 is a Tuesday, 2026-11-04 a Wednesday.
const TUESDAY = '2026-11-03';
const WEDNESDAY = '2026-11-04';

const blocks = [
  { day_of_week: 2, block_entire_day: false, time_slots: ['09:00', '10:00'] },
  { date: TUESDAY, block_entire_day: false, time_slots: ['14:00'] },
  { date: '2026-11-10', block_entire_day: true },
];

describe('weekly blocks', () => {
  it('hides the blocked hours on that weekday', () => {
    expect(filterSlotsByRecurringBlocks(['09:00', '11:00'], TUESDAY, blocks)).toEqual(['11:00']);
  });

  it('leaves other weekdays alone', () => {
    expect(filterSlotsByRecurringBlocks(['09:00', '11:00'], WEDNESDAY, blocks)).toEqual(['09:00', '11:00']);
  });

  it('hides every hour when the whole day is blocked', () => {
    const allDay = [{ day_of_week: 2, block_entire_day: true }];
    expect(filterSlotsByRecurringBlocks(['09:00', '17:00'], TUESDAY, allDay)).toEqual([]);
  });
});

describe('date blocks', () => {
  it('hides the blocked hours on that date only', () => {
    expect(filterSlotsByRecurringBlocks(['14:00', '15:00'], TUESDAY, blocks)).toEqual(['15:00']);
    expect(filterSlotsByRecurringBlocks(['14:00', '15:00'], WEDNESDAY, blocks)).toEqual(['14:00', '15:00']);
  });

  it('hides the whole day when asked to', () => {
    expect(filterSlotsByRecurringBlocks(['09:00', '21:00'], '2026-11-10', blocks)).toEqual([]);
  });

  it('matches 12h availability labels against 24h stored slots', () => {
    // availability stores "2:00 PM"; a block stores "14:00"
    expect(filterSlotsByRecurringBlocks(['2:00 PM', '3:00 PM'], TUESDAY, blocks)).toEqual(['3:00 PM']);
  });

  it('needs the date to apply at all', () => {
    // Called with a weekday but no date, only the weekly block can match.
    expect(isSlotBlockedByRecurring(blocks, 2, '14:00')).toBe(false);
    expect(isSlotBlockedByRecurring(blocks, 2, '14:00', TUESDAY)).toBe(true);
  });

  it('reads a timestamp-shaped date the same as a plain one', () => {
    const fromDb = [{ date: '2026-11-03T00:00:00+00:00', block_entire_day: true }];
    expect(isSlotBlockedByDate(fromDb, TUESDAY, '09:00')).toBe(true);
  });
});

describe('storing slots', () => {
  it('normalizes to 24h, sorts, and drops duplicates', () => {
    expect(normalizeTimeSlotsForStorage(['9:00 AM', '09:00', '2:00 PM'])).toEqual(['09:00', '14:00']);
  });

  it('treats an empty choice as no specific slots', () => {
    expect(normalizeTimeSlotsForStorage([])).toBeNull();
    expect(normalizeTimeSlotsForStorage(null)).toBeNull();
  });

  it('keeps midday and midnight the right way round', () => {
    expect(normalizeSlotTime('12:00 PM')).toBe('12:00');
    expect(normalizeSlotTime('12:00 AM')).toBe('00:00');
  });
});

describe('calendar events', () => {
  it('runs contiguous hours together and splits on a gap', () => {
    expect(TimeBlockingService.groupSlotsIntoRuns(['09:00', '10:00', '14:00'])).toEqual([
      { start: '09:00', end: '11:00' },
      { start: '14:00', end: '15:00' },
    ]);
  });

  it('closes a single late slot at the end of the hour', () => {
    expect(TimeBlockingService.groupSlotsIntoRuns(['21:00'])).toEqual([{ start: '21:00', end: '22:00' }]);
  });

  it('is order-independent and ignores duplicates', () => {
    expect(TimeBlockingService.groupSlotsIntoRuns(['10:00', '09:00', '10:00'])).toEqual([
      { start: '09:00', end: '11:00' },
    ]);
  });

  it('stops the weekly repeat six months out', () => {
    const horizon = TimeBlockingService.sixMonthHorizon(new Date('2026-10-22T12:00:00Z'));
    expect(horizon.date).toBe('2027-04-22');
    expect(horizon.until).toBe('20270422T235959Z');
  });
});
