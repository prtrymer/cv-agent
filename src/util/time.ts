export interface WorkingHours { days: number[]; start: string; end: string; czechHolidays: boolean; extraDaysOff: string[] }

export function localParts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  const weekday = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[p.weekday] ?? 0;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour), mm: Number(p.minute), weekday, ymd: `${p.year}-${p.month}-${p.day}` };
}
export const localDay = (d: Date, tz: string): string => localParts(d, tz).ymd;

/** Easter Sunday (Gregorian, Meeus/Jones/Butcher). */
export function easter(y: number): { m: number; d: number } {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return { m: month, d: ((h + l - 7 * m + 114) % 31) + 1 };
}

export function czechHolidays(y: number): Set<string> {
  const fixed = ['01-01', '05-01', '05-08', '07-05', '07-06', '09-28', '10-28', '11-17', '12-24', '12-25', '12-26'];
  const e = easter(y);
  const sunday = Date.UTC(y, e.m - 1, e.d);
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return new Set([...fixed.map((md) => `${y}-${md}`), iso(sunday - 2 * 86_400_000), iso(sunday + 86_400_000)]);
}

export function isWorkingTime(now: Date, wh: WorkingHours, tz: string): { ok: boolean; reason?: string } {
  const p = localParts(now, tz);
  if (!wh.days.includes(p.weekday)) return { ok: false, reason: 'weekend' };
  if (wh.czechHolidays && czechHolidays(p.y).has(p.ymd)) return { ok: false, reason: 'public holiday' };
  if (wh.extraDaysOff.includes(p.ymd)) return { ok: false, reason: 'day off' };
  const [sh, sm] = wh.start.split(':').map(Number);
  const [eh, em] = wh.end.split(':').map(Number);
  const mins = p.hh * 60 + p.mm;
  if (mins < sh * 60 + sm || mins >= eh * 60 + em) return { ok: false, reason: 'outside hours' };
  return { ok: true };
}
