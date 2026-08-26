import { X } from 'lucide-react';
import { format, parseISO } from 'date-fns';

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Earliest date the picker will offer — a departure cannot precede its arrival. */
  min?: string;
  /** Latest date the picker will offer. */
  max?: string;
  /** What an empty field says. "Select date" unless the blank means something. */
  emptyLabel?: string;
  /**
   * Shows an X that empties the field. Only worth having where empty is a
   * real answer rather than an unfinished one: a stay with no departure is a
   * single day, and iOS gives no way to clear a date input on its own.
   */
  onClear?: () => void;
}

// Native <input type="date"> styling (border, padding, width) is
// unreliable across browsers — iOS Safari in particular can ignore
// width/padding entirely and render at its own intrinsic size. Rather
// than keep fighting that, the native input is invisible and only
// handles taps (opening the OS date picker); the visible box is a
// plain styled div we fully control.
export function DateField({ label, value, onChange, min, max, emptyLabel, onClear }: Props) {
  return (
    <label className="date-label">
      <span>{label}</span>
      {/* The clear button overlays the right-hand end of the box, so the box
          has to know to keep that end free — otherwise the date runs under
          the X, which is exactly what it did. */}
      <div className={`date-field-wrap ${onClear ? 'date-field-wrap--clearable' : ''}`}>
        <input
          type="date"
          className="date-field-native"
          value={value}
          min={min}
          max={max}
          onChange={e => onChange(e.target.value)}
        />
        <div className={`date-field-display ${!value ? 'date-field-display--empty' : ''}`}>
          {value ? format(parseISO(value), 'MMM d, yyyy') : (emptyLabel ?? 'Select date')}
        </div>
        {/* Above the invisible input rather than beside it, because that input
            covers the whole box to catch taps — a clear button underneath it
            would open the picker instead of clearing. */}
        {onClear && value && (
          <button
            type="button"
            className="date-field-clear"
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={e => { e.preventDefault(); onClear(); }}
          >
            <X size={14} />
          </button>
        )}
      </div>
    </label>
  );
}
