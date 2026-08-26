/**
 * Laying out a month, in the same plain `YYYY-MM-DD` strings the rest of the
 * date handling uses.
 *
 * The rule from lib/timeline.ts holds here and matters more, because a
 * calendar is where it would be easiest to break: a date has no time zone, so
 * parsing one into a local `Date` and reading it back applies the viewer's
 * offset to a value that never had one. Tap the 8th in Los Angeles, store a
 * `Date`, format it, and you have recorded the 7th.
 *
 * So nothing here round-trips a value through a Date. The two places a Date
 * appears are pure calendar arithmetic — which day of the week a month starts
 * on, and how many days it has — and both are done in UTC, where the answer
 * is a property of the calendar rather than of where you are standing.
 */

const pad = (n: number) => String(n).padStart(2, '0');

export interface YearMonth {
  year: number;
  /** 1-12, not the 0-11 a Date uses. Off-by-one months are not worth the risk. */
  month: number;
}

/** `2026-11-08` → `{ year: 2026, month: 11 }`. */
export function monthOf(iso: string): YearMonth {
  const [year, month] = iso.split('-').map(Number);
  return { year, month };
}

/** `{ year: 2026, month: 11 }`, 8 → `2026-11-08`. */
export function isoOf(ym: YearMonth, day: number): string {
  return `${ym.year}-${pad(ym.month)}-${pad(day)}`;
}

/** Today, from the viewer's own clock — the one date that is genuinely local. */
export function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** How many days the month has. Day 0 of the next month is the last of this one. */
export function daysInMonth({ year, month }: YearMonth): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Which column the 1st falls in, Monday first.
 *
 * Monday rather than Sunday because every date this app prints is formatted
 * `en-GB`, and a grid that disagrees with the labels beside it is a small
 * lie the eye has to correct for.
 */
export function firstWeekdayIndex({ year, month }: YearMonth): number {
  const sundayFirst = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return (sundayFirst + 6) % 7;
}

/** Step by whole months, rolling the year over. */
export function addMonths({ year, month }: YearMonth, delta: number): YearMonth {
  const zeroBased = year * 12 + (month - 1) + delta;
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 };
}

/**
 * The cells of one month, in reading order, with leading blanks for the days
 * before the 1st.
 *
 * Trailing blanks are deliberately NOT padded out to a whole number of weeks:
 * an empty cell is not a target, and rows of them at the bottom only push the
 * confirm button further down a phone screen. The grid's own row count varies
 * between 4 and 6 rows, which is what a paper calendar does too.
 */
export function monthGrid(ym: YearMonth): (string | null)[] {
  const blanks: null[] = Array(firstWeekdayIndex(ym)).fill(null);
  const days = Array.from({ length: daysInMonth(ym) }, (_, i) => isoOf(ym, i + 1));
  return [...blanks, ...days];
}

/** The month's name and year, as a heading: "November 2026". */
export function monthLabel({ year, month }: YearMonth): string {
  const name = new Date(Date.UTC(2000, month - 1, 1))
    .toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  return `${name} ${year}`;
}

/** Monday-first initials for the column headers. */
export const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/**
 * Whether `iso` falls inside the closed range `[from, to]`.
 *
 * String comparison, because ISO dates sort correctly as text and converting
 * them to anything else here would reintroduce exactly the problem this file
 * exists to avoid.
 */
export function isWithin(iso: string, from: string, to: string): boolean {
  return iso >= from && iso <= to;
}
