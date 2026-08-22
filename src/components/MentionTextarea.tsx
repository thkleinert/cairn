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
  /**
   * Backspace pressed with the caret at position 0 and nothing selected.
   *
   * The keystroke is always swallowed when this is provided — at offset 0 with
   * no selection there is nothing to the left to delete, so preventing the
   * default costs nothing and spares the handler from racing the browser while
   * it awaits. The handler decides what happens; it does not decide whether
   * the key was consumed.
   */
  onBackspaceAtStart?: () => void | Promise<void | boolean>;
  /**
   * Tab and Shift+Tab. The edit toolbar used to carry indent and outdent as
   * buttons; with those gone the gesture is a drag, which a keyboard cannot
   * perform — so the binding every outliner already uses stands in for it.
   */
  onIndent?: (delta: 1 | -1) => void;
  /** Alt+ArrowUp / Alt+ArrowDown — the keyboard's route to reordering. */
  onMoveBullet?: (direction: 1 | -1) => void;
  /** True when Shift+Tab has nothing left to outdent, so Tab stops trapping. */
  atOuterLevel?: boolean;
  places: Place[];
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  ariaLabel?: string;
  /**
   * The underlying textarea, so a caller can put focus back after something
   * moved the row in the DOM. Reordering a keyed list moves the node rather
   * than remounting it, which blurs it and does NOT re-run autoFocus.
   */
  inputRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
}

// A textarea that grows with its content and offers the trip's places after an
// "@". Shared by the add-a-bullet box and inline bullet editing so the two
// can't drift apart.
export function MentionTextarea({
  value, onChange, onSubmit, onBlur, onCancel, onBackspaceAtStart, onIndent, onMoveBullet, atOuterLevel, places,
  placeholder, autoFocus, className = '', ariaLabel, inputRef,
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
    if (!autoFocus) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Caret at the END, not the start. Opening a bullet by tapping the space
    // after its text is how you go back to carry on writing, and landing
    // before the first character means every one of those taps is followed by
    // a second one to get to where you meant. A browser puts the caret at 0 on
    // a programmatic focus, which is the wrong default for an editor you enter
    // by pointing at the thing you want to append to.
    const end = el.value.length;
    el.setSelectionRange(end, end);
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
    // Tab moves the bullet, it does not move focus. In an outliner that is what
    // the key means, and there is nowhere useful for focus to go — the next
    // control is the next bullet's editor, which Enter already reaches.
    // Alt keeps the bare arrows for the caret, where they belong.
    if (onMoveBullet && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      onMoveBullet(e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.key === 'Tab' && onIndent) {
      // Shift+Tab at the outer level is deliberately NOT swallowed: with Tab
      // bound to indent there would otherwise be no way to leave this field
      // with the keyboard at all, and Escape discards the edit rather than
      // committing it. Outdenting until the bullet is at depth 0 and pressing
      // Shift+Tab once more moves focus on, which is a predictable exit rather
      // than a trap.
      if (e.shiftKey && atOuterLevel) return;
      e.preventDefault();
      onIndent(e.shiftKey ? -1 : 1);
      return;
    }
    // Only a bare caret at the very start counts: with a selection, Backspace
    // is deleting that selection, and mid-text it's deleting a character.
    if (
      e.key === 'Backspace' && onBackspaceAtStart &&
      e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0
    ) {
      // Prevent first: the handler may be async, and by the time it resolves
      // the browser has already eaten a character from the row above.
      e.preventDefault();
      void Promise.resolve(onBackspaceAtStart());
      return;
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
        ref={el => { ref.current = el; if (inputRef) inputRef.current = el; }}
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
