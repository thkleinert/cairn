import { useState, useRef, useEffect, useMemo, useLayoutEffect } from 'react';
import { AtSign } from 'lucide-react';
import { findMentionQuery, matchPlaces, applyMention } from '../lib/mentions';
import type { Place } from '../types';

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Enter (without the suggestion popup open) — Shift+Enter still newlines. */
  onSubmit?: () => void;
  onBlur?: () => void;
  onCancel?: () => void;
  places: Place[];
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  ariaLabel?: string;
}

// A textarea that grows with its content and offers the trip's places after an
// "@". Shared by the add-a-bullet box and inline bullet editing so the two
// can't drift apart.
export function MentionTextarea({
  value, onChange, onSubmit, onBlur, onCancel, places,
  placeholder, autoFocus, className = '', ariaLabel,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  // The value the popup was last dismissed for. Needed because a just-inserted
  // mention still matches its own query ("@Hotel Wandl " finds Hotel Wandl), so
  // without this the popup stays open and the next Enter re-inserts the mention
  // instead of committing the note. Any further typing changes `value` and the
  // popup becomes eligible again.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  // Grow to fit. Reset to auto first or the height only ever ratchets up.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const mention = findMentionQuery(value, caret);
  const suggestions = useMemo(
    () => (mention ? matchPlaces(places, mention.query) : []),
    [mention?.at, mention?.query, places] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const open = !!mention && suggestions.length > 0 && dismissedFor !== value;

  useEffect(() => { setIndex(0); }, [mention?.at, mention?.query]);

  const insert = (place: Place) => {
    if (!mention) return;
    const next = applyMention(value, mention, place, caret);
    onChange(next.text);
    setDismissedFor(next.text);
    // After React writes the new value the browser parks the caret at the end,
    // so the next keystroke would land in the wrong place.
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => (i + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => (i - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); insert(suggestions[index]); return; }
      if (e.key === 'Escape') {
        // Dismiss the popup only — the surrounding sheet must stay open.
        e.preventDefault(); e.stopPropagation();
        setDismissedFor(value);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && onSubmit) {
      e.preventDefault();
      onSubmit();
      return;
    }
    if (e.key === 'Escape' && onCancel) { e.preventDefault(); e.stopPropagation(); onCancel(); }
  };

  const sync = (e: React.SyntheticEvent<HTMLTextAreaElement>) =>
    setCaret(e.currentTarget.selectionStart ?? 0);

  return (
    <div className="mention-field">
      <textarea
        ref={ref}
        rows={1}
        className={`input mention-input ${className}`}
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={e => { onChange(e.target.value); setCaret(e.target.selectionStart ?? 0); }}
        onKeyUp={sync}
        onClick={sync}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      {open && (
        <ul className="mention-suggestions">
          {suggestions.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                className={`mention-suggestion ${i === index ? 'mention-suggestion--active' : ''}`}
                // onMouseDown, not onClick: onClick fires after the textarea's
                // blur, which commits and unmounts the field before insertion.
                onMouseDown={e => { e.preventDefault(); insert(p); }}
              >
                <AtSign size={14} />
                <span className="mention-suggestion-name">{p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
