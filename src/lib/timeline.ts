import type { Place, PlaceVisit } from '../types';

/**
 * Turning a trip's visits into something you can read down a page.
 *
 * Pure, and separate from the components, because two screens ask the same
 * questions of the same rows — the outliner's strip and the list view's date
 * line — and answering them twice is how they drift.
 *
 * Dates are handled as plain `YYYY-MM-DD` strings throughout. Parsing them into
 * Date objects would apply the viewer's time zone to a value that has none: a
 * stay recorded as the 8th shows as the 7th to anyone west of the booking, and
 * a night count comes out one short. String comparison already sorts ISO dates
 * correctly, and the only arithmetic needed is a day difference, which is done
 * in UTC below.
 */

export interface TimelineEntry {
  visit: PlaceVisit;
  place: Place;
  /** Nights between arrival and departure; 0 for a single-day visit. */
  nights: number;
  /** Days between this arrival and the previous departure. 0 when they meet. */
  gapBefore: number;
  /** True when this visit starts before the one before it has ended. */
  overlapsPrevious: boolean;
}

/** Whole days from `a` to `b`, both `YYYY-MM-DD`. Negative when b precedes a. */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** The last day of a visit — its end, or its start when it is a single day. */
export function lastDay(visit: PlaceVisit): string {
  return visit.ends_on ?? visit.starts_on;
}

/**
 * Visits in the order they happen, each paired with its place.
 *
 * Visits whose place has gone are dropped rather than rendered blank: the
 * foreign key cascades, so this only happens in the window before a refetch
 * catches up, and half a row is worse than none.
 *
 * Ties are broken by the longer stay first, then by place name, so a day when
 * one stay ends and another begins reads in the order you actually move.
 */
export function buildTimeline(visits: PlaceVisit[], places: Place[]): TimelineEntry[] {
  const byId = new Map(places.map(p => [p.id, p]));

  const rows = visits
    .map(visit => ({ visit, place: byId.get(visit.place_id) }))
    .filter((r): r is { visit: PlaceVisit; place: Place } => !!r.place)
    .sort((a, b) =>
      a.visit.starts_on.localeCompare(b.visit.starts_on) ||
      daysBetween(a.visit.starts_on, lastDay(b.visit)) -
        daysBetween(b.visit.starts_on, lastDay(a.visit)) ||
      a.place.name.localeCompare(b.place.name));

  let previousEnd: string | null = null;
  return rows.map(({ visit, place }) => {
    const gap = previousEnd ? daysBetween(previousEnd, visit.starts_on) : 0;
    const entry: TimelineEntry = {
      visit,
      place,
      nights: Math.max(0, daysBetween(visit.starts_on, lastDay(visit))),
      gapBefore: Math.max(0, gap),
      overlapsPrevious: gap < 0,
    };
    // Carried forward as the furthest end seen, not this row's end: a short
    // stay nested inside a long one would otherwise report the long one as a
    // gap when the next visit begins.
    if (!previousEnd || lastDay(visit) > previousEnd) previousEnd = lastDay(visit);
    return entry;
  });
}

/** Every visit for one place, earliest first — what a place's own card shows. */
export function visitsForPlace(visits: PlaceVisit[], placeId: string): PlaceVisit[] {
  return visits
    .filter(v => v.place_id === placeId)
    .sort((a, b) => a.starts_on.localeCompare(b.starts_on));
}

/**
 * A visit as a short label: "8 – 12 Nov", or "12 Nov – 3 Dec" when it crosses a
 * month, or "8 Nov" for a single day. The year is added only when the visit is
 * not in the year given, which keeps the common case short without ever being
 * ambiguous about a trip that straddles New Year.
 */
export function formatVisit(visit: PlaceVisit, thisYear?: number): string {
  const fmt = (iso: string, withMonth: boolean, withYear: boolean) => {
    const [y, m, d] = iso.split('-').map(Number);
    const month = new Date(Date.UTC(2000, m - 1, 1))
      .toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
    return `${d}${withMonth ? ` ${month}` : ''}${withYear ? ` ${y}` : ''}`;
  };
  const [sy, sm] = visit.starts_on.split('-').map(Number);
  const end = visit.ends_on;
  const showStartYear = thisYear !== undefined && sy !== thisYear;

  if (!end || end === visit.starts_on) return fmt(visit.starts_on, true, showStartYear);

  const [ey, em] = end.split('-').map(Number);
  const sameMonth = sy === ey && sm === em;
  const showEndYear = thisYear !== undefined && ey !== thisYear;
  return `${fmt(visit.starts_on, !sameMonth, showStartYear && !sameMonth)} – ${fmt(end, true, showEndYear)}`;
}
