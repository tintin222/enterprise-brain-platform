// When recurring work is due (plan section 11): daily jobs at an hour in the installation's time zone, and jobs
// every few minutes. Pure functions, so the runner's timing is unit tested without a clock or a database.

export interface LocalParts {
  /** YYYY-MM-DD in the time zone. */
  day: string;
  hour: number;
  minute: number;
}

/** The date and time in `timeZone` for an instant, from Intl (no library). */
export function localParts(at: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) };
}

/** The period a daily job owes now: its day once the local hour has been reached, otherwise nothing. */
export function dailyPeriod(at: Date, timeZone: string, hour: number): string | undefined {
  const local = localParts(at, timeZone);
  return local.hour >= hour ? local.day : undefined;
}

/** The period of a job that runs every `minutes` minutes: the start of the current slot, as an ISO minute. */
export function everyMinutesPeriod(at: Date, minutes: number): string {
  const slotMs = minutes * 60_000;
  return new Date(Math.floor(at.getTime() / slotMs) * slotMs).toISOString().slice(0, 16);
}
