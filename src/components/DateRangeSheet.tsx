import { useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useSwipeToClose } from '../hooks/useSwipeToClose';
import { useEscapeClose } from '../hooks/useEscapeClose';
import {
  monthOf, todayIso, monthGrid, monthLabel, addMonths, isWithin,
  WEEKDAY_INITIALS, type YearMonth,
} from '../lib/calendar';
import { formatRange, daysBetween } from '../lib/timeline';

export interface DateRange {
  start: string;
  /** Null is a single day, not an open end — the same rule place_visits uses. */
  end: string | null;
}

interface Props {
  title: string;
  value: DateRange | null;
  /**
   * Null means "no dates at all", which only some callers allow.
   *
   * A caller that writes to the network returns false when the write failed,
   * and the sheet stays open with the range still on screen. The two-input
   * version kept its half-made row for exactly this reason, and closing
   * unconditionally quietly gave that up: a failed insert left a toast and
   * nothing to retry from. Anything other than false — including a caller
   * that returns nothing because it cannot fail — closes.
   */
  onCommit: (range: DateRange | null) => void | boolean | Promise<void | boolean>;
  onClose: () => void;
  /** Whether clearing to nothing is a legal answer. A visit must have a date. */
  clearable?: boolean;
  startLabel?: string;
  endLabel?: string;
  /** The year that can go unsaid — see DateRangeField. */
  year?: number;
}

// One calendar that picks both ends of a range, replacing the two separate
// date fields this app used everywhere it needed one.
//
// Two fields could not express a range; they could only hold two independent
// dates and hope. That is not a styling complaint — it is where the bugs came
// from. Each field fired its own change, so a departure could be written
// before the arrival it belonged to, an end could contradict a start that was
// still in flight, and the code that stopped a half-finished pair from being
// saved twice needed refs to coordinate two inputs mid-write. A range that is
// chosen as one thing and committed once has none of those states to be in.
//
// Nothing here parses a value into a Date. See lib/calendar.ts.
//
// Month navigation is arrows only, deliberately. The obvious gesture would be
// swiping between months, and this sheet lives inside .bottom-sheet, which has
// overflow-y: auto and therefore overflow-x: auto. A horizontal gesture in
// that box is the trap that has already cost this repo four wrong fixes on the
// outliner: the container pans sideways and eats the drag before any handler
// sees it. Arrows cannot be stolen.
export function DateRangeSheet({
  title, value, onCommit, onClose, clearable = false,
  startLabel = 'Start', endLabel = 'End', year,
}: Props) {
  // The half-made selection. `start` with no `end` is both a single day and a
  // range waiting for its second tap — which one it turns out to be is decided
  // by whether the next tap lands or the sheet is confirmed as is.
  const [draft, setDraft] = useState<DateRange | null>(value);
  // Which end the next tap sets. Reset to 'start' whenever a range completes,
  // so tapping again begins a new one rather than nudging the old one.
  const [picking, setPicking] = useState<'start' | 'end'>('start');
  // Blocks a second tap while a write is in flight. The old two-input editor
  // needed a ref for this because its inputs stayed live during the write;
  // here there is one button and it can simply be disabled.
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<YearMonth>(
    monthOf(value?.start ?? todayIso()),
  );

  const { sheetRef, handleProps } = useSwipeToClose(onClose);
  useEscapeClose(onClose);

  const today = todayIso();
  const cells = monthGrid(view);

  const tap = (iso: string) => {
    // A first tap, or the start of a new range.
    if (picking === 'start' || !draft) {
      setDraft({ start: iso, end: null });
      setPicking('end');
      return;
    }
    // A second tap before the first restarts rather than refuses. Someone
    // going backwards through a calendar means "actually, from here" far more
    // often than they mean to be told no, and there is no other way to move a
    // start earlier without first clearing the whole thing.
    if (iso < draft.start) {
      setDraft({ start: iso, end: null });
      setPicking('end');
      return;
    }
    // Landing on the start again means one day, which is what a null end is.
    setDraft({ start: draft.start, end: iso === draft.start ? null : iso });
    setPicking('start');
  };

  // What the current selection covers, for painting the grid. While a range is
  // half-made this is just the one day, so nothing is shaded until there is a
  // span to shade.
  const from = draft?.start ?? null;
  const to = draft?.end ?? draft?.start ?? null;

  const nights = draft && draft.end ? daysBetween(draft.start, draft.end) : 0;

  return (
    <div className="bottom-sheet-overlay" onClick={onClose}>
      <div
        className="bottom-sheet date-range-sheet"
        ref={sheetRef}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="bottom-sheet-handle" {...handleProps} />

        <div className="sheet-header-row">
          <h2 className="place-name">{title}</h2>
          {/* type="button" is load-bearing: DateRangeField renders this sheet
              as a DOM descendant of whatever contains it, and in the create-trip
              form that is a <form>. An untyped button there is a SUBMIT button,
              so "close the calendar" would mean "create the trip". */}
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        {/* What has been chosen so far, in the words it will be read back in
            elsewhere — formatRange is the same function the timeline and the
            list rows use, so the picker cannot describe a range differently
            from the screens that show it. */}
        <div className="range-summary">
          <div className="range-summary-ends">
            <span className={`range-end ${picking === 'start' ? 'range-end--active' : ''}`}>
              <span className="range-end-label">{startLabel}</span>
              <span className="range-end-value">{draft ? formatRange(draft.start, null) : '—'}</span>
            </span>
            <span className="range-end-arrow" aria-hidden="true">→</span>
            <span className={`range-end ${picking === 'end' ? 'range-end--active' : ''}`}>
              <span className="range-end-label">{endLabel}</span>
              <span className="range-end-value">
                {draft?.end ? formatRange(draft.end, null) : draft ? 'Same day' : '—'}
              </span>
            </span>
          </div>
          {draft && (
            <p className="range-summary-nights">
              {nights === 0 ? 'One day' : `${nights} night${nights === 1 ? '' : 's'}`}
            </p>
          )}
        </div>

        <div className="calendar">
          <div className="calendar-nav">
            <button
              type="button"
              className="calendar-nav-btn"
              aria-label="Previous month"
              onClick={() => setView(v => addMonths(v, -1))}
            >
              <ChevronLeft size={20} />
            </button>
            <span className="calendar-month" aria-live="polite">{monthLabel(view)}</span>
            <button
              type="button"
              className="calendar-nav-btn"
              aria-label="Next month"
              onClick={() => setView(v => addMonths(v, 1))}
            >
              <ChevronRight size={20} />
            </button>
          </div>

          <div className="calendar-weekdays" aria-hidden="true">
            {WEEKDAY_INITIALS.map((d, i) => (
              <span key={i} className="calendar-weekday">{d}</span>
            ))}
          </div>

          {/* Plain buttons, deliberately. role="grid" needs role="row" between
              it and its cells, and role="gridcell" overrides the button role
              these already have — a half-built grid widget announces worse
              than the native input this replaced. Each day names itself in
              full, because "8" on its own is not a date. */}
          <div className="calendar-grid" role="group" aria-label={monthLabel(view)}>
            {cells.map((iso, i) => {
              if (!iso) return <span key={`blank-${i}`} className="calendar-cell calendar-cell--blank" />;
              const isStart = iso === draft?.start;
              const isEnd = draft?.end ? iso === draft.end : false;
              const inRange = from && to ? isWithin(iso, from, to) : false;
              return (
                <button
                  key={iso}
                  type="button"
                  aria-label={`${Number(iso.slice(8))} ${monthLabel(view)}`}
                  aria-pressed={inRange}
                  className={[
                    'calendar-cell',
                    inRange ? 'calendar-cell--in-range' : '',
                    isStart ? 'calendar-cell--start' : '',
                    isEnd ? 'calendar-cell--end' : '',
                    // A single-day selection is both ends at once, and gets the
                    // rounding of both rather than looking like an open range.
                    isStart && !draft?.end ? 'calendar-cell--only' : '',
                    iso === today ? 'calendar-cell--today' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => tap(iso)}
                >
                  {Number(iso.slice(8))}
                </button>
              );
            })}
          </div>
        </div>

        <div className="range-actions">
          {clearable && (
            <button
              type="button"
              className="btn-ghost"
              onClick={async () => {
                if (saving) return;
                setSaving(true);
                const ok = await onCommit(null);
                setSaving(false);
                if (ok !== false) { setDraft(null); setPicking('start'); onClose(); }
              }}
            >
              Clear
            </button>
          )}
          {/* One write, at the end. Every earlier version of this wrote as you
              typed, which is where the half-saved states came from. */}
          <button
            type="button"
            className="btn-primary"
            disabled={!draft || saving}
            onClick={async () => {
              if (!draft || saving) return;
              setSaving(true);
              const ok = await onCommit(draft);
              setSaving(false);
              if (ok !== false) onClose();
            }}
          >
            {saving ? 'Saving…' : draft ? `Use ${formatRange(draft.start, draft.end, year)}` : 'Pick a date'}
          </button>
        </div>
      </div>
    </div>
  );
}
