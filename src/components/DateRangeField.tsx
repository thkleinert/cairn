import { useState } from 'react';
import { Calendar } from 'lucide-react';
import { DateRangeSheet, type DateRange } from './DateRangeSheet';
import { formatRange } from '../lib/timeline';

interface Props {
  label: string;
  value: DateRange | null;
  onChange: (range: DateRange | null) => void | boolean | Promise<void | boolean>;
  /** Whether "no dates" is a legal answer. A trip may be undated; a visit not. */
  clearable?: boolean;
  /** What an unset field invites you to do. */
  placeholder?: string;
  startLabel?: string;
  endLabel?: string;
  /** Heading of the sheet this opens. */
  title?: string;
  /**
   * The year that can go unsaid. Without it a range renders as "4 – 11 Mar"
   * whatever year it is in, which is fine inside a trip whose year is
   * established elsewhere on the screen and ambiguous for a trip's own dates.
   */
  year?: number;
  disabled?: boolean;
}

// The read-only face of a date range: one line saying what is chosen, which
// opens the calendar when tapped.
//
// It replaces the pair of <input type="date"> boxes this app used in all three
// places it needed a range. Those relied on the OS picker, which is genuinely
// the better control for ONE date — it is familiar, accessible, and needs no
// code — but it cannot express a range at all, so two of them side by side
// were two independent dates that the surrounding code had to keep agreeing
// with each other. See DateRangeSheet for what that cost.
export function DateRangeField({
  label, value, onChange, clearable = false,
  placeholder = 'Add dates', startLabel, endLabel, title, year, disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="range-field">
      <span className="detail-label">{label}</span>
      <button
        type="button"
        className={`range-field-button ${!value ? 'range-field-button--empty' : ''}`}
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        <Calendar size={15} aria-hidden="true" />
        <span className="range-field-value">
          {value ? formatRange(value.start, value.end, year) : placeholder}
        </span>
      </button>

      {open && (
        <DateRangeSheet
          title={title ?? label}
          value={value}
          clearable={clearable}
          startLabel={startLabel}
          endLabel={endLabel}
          year={year}
          onCommit={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
