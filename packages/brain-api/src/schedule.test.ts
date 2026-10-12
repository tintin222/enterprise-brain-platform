import { describe, expect, it } from 'vitest';
import { dailyPeriod, everyMinutesPeriod, localParts } from './schedule.ts';

describe('schedule', () => {
  it('reads the local day and hour in the installation time zone', () => {
    // 05:30 UTC is 08:30 in Istanbul (UTC+3) and 01:30 the same day in New York (UTC-4 in October).
    const at = new Date('2026-10-13T05:30:00Z');
    expect(localParts(at, 'Europe/Istanbul')).toEqual({ day: '2026-10-13', hour: 8, minute: 30 });
    expect(localParts(at, 'America/New_York')).toEqual({ day: '2026-10-13', hour: 1, minute: 30 });
    // 22:30 UTC is already the next day in Istanbul.
    expect(localParts(new Date('2026-10-13T22:30:00Z'), 'Europe/Istanbul').day).toBe('2026-10-14');
  });

  it('owes a daily job its day once the hour is reached, and nothing before', () => {
    expect(dailyPeriod(new Date('2026-10-13T04:59:00Z'), 'Europe/Istanbul', 8)).toBeUndefined();
    expect(dailyPeriod(new Date('2026-10-13T05:00:00Z'), 'Europe/Istanbul', 8)).toBe('2026-10-13');
    expect(dailyPeriod(new Date('2026-10-13T20:00:00Z'), 'Europe/Istanbul', 8)).toBe('2026-10-13');
  });

  it('gives every-N-minutes jobs the start of their slot', () => {
    expect(everyMinutesPeriod(new Date('2026-10-13T05:34:59Z'), 5)).toBe('2026-10-13T05:30');
    expect(everyMinutesPeriod(new Date('2026-10-13T05:35:00Z'), 5)).toBe('2026-10-13T05:35');
  });
});
