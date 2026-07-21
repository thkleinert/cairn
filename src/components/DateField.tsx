import { format, parseISO } from 'date-fns';

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

// Native <input type="date"> styling (border, padding, width) is
// unreliable across browsers — iOS Safari in particular can ignore
// width/padding entirely and render at its own intrinsic size. Rather
// than keep fighting that, the native input is invisible and only
// handles taps (opening the OS date picker); the visible box is a
// plain styled div we fully control.
export function DateField({ label, value, onChange }: Props) {
  return (
    <label className="date-label">
      <span>{label}</span>
      <div className="date-field-wrap">
        <input
          type="date"
          className="date-field-native"
          value={value}
          onChange={e => onChange(e.target.value)}
        />
        <div className={`date-field-display ${!value ? 'date-field-display--empty' : ''}`}>
          {value ? format(parseISO(value), 'MMM d, yyyy') : 'Select date'}
        </div>
      </div>
    </label>
  );
}
