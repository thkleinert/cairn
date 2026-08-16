import { useState, useRef, useEffect, useMemo } from 'react';
import { X, NotebookPen, AtSign } from 'lucide-react';
import { useSwipeToClose } from '../hooks/useSwipeToClose';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { parseMentions, findMentionQuery, matchPlaces, applyMention } from '../lib/mentions';
import type { Place, Tag, Trip } from '../types';

interface Props {
  trip: Trip;
  places: Place[];
  allTags: Tag[];
  onSaveNotes: (notes: string | null) => void;
  onSelectPlace: (placeId: string) => void;
  onClose: () => void;
}

// Everything written down for a trip, in one place: the trip-wide scratchpad
// on top, then every place that has a note. Places without notes are omitted —
// on a long trip they'd be most of the page, and this is a reading surface.
export function TripNotesSheet({ trip, places, allTags, onSaveNotes, onSelectPlace, onClose }: Props) {
  const [notes, setNotes] = useState(trip.notes ?? '');
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState(!trip.notes);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const [caret, setCaret] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { sheetRef, handleProps } = useSwipeToClose(handleClose);

  // Same contract as PlaceDetailSheet: never silently discard an edit, flush
  // it on whichever path closes the sheet.
  function handleClose() {
    if (dirty) onSaveNotes(notes.trim() || null);
    onClose();
  }
  useEscapeClose(handleClose);

  // A collaborator's edit (or our own save round-tripping) should land in the
  // field, but must never overwrite something we're part-way through typing.
  useEffect(() => {
    if (!dirty) setNotes(trip.notes ?? '');
  }, [trip.notes, dirty]);

  const mention = editing ? findMentionQuery(notes, caret) : null;
  const suggestions = useMemo(
    () => (mention ? matchPlaces(places, mention.query) : []),
    [mention?.at, mention?.query, places] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const showSuggestions = !!mention && suggestions.length > 0;

  useEffect(() => { setSuggestIndex(0); }, [mention?.query, mention?.at]);

  const insertMention = (place: Place) => {
    if (!mention) return;
    const next = applyMention(notes, mention, place, caret);
    setNotes(next.text);
    setDirty(true);
    // Restore the caret after React has written the new value, or the browser
    // parks it at the end and the next keystroke lands in the wrong spot.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!showSuggestions) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSuggestIndex(i => (i + 1) % suggestions.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSuggestIndex(i => (i - 1 + suggestions.length) % suggestions.length); }
    else if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); insertMention(suggestions[suggestIndex]); }
    else if (e.key === 'Escape') {
      // Dismiss the popup without closing the whole sheet.
      e.preventDefault(); e.stopPropagation();
      setCaret(-1);
    }
  };

  const syncCaret = (e: React.SyntheticEvent<HTMLTextAreaElement>) =>
    setCaret(e.currentTarget.selectionStart ?? 0);

  const withNotes = places.filter(p => (p.notes ?? '').trim().length > 0);
  const tagsOf = (place: Place) =>
    allTags.filter(t => (place.tags ?? []).some(pt => pt.id === t.id));

  const jumpToPlace = (placeId: string) => {
    if (dirty) onSaveNotes(notes.trim() || null);
    onSelectPlace(placeId);
  };

  return (
    <div className="bottom-sheet-overlay" onClick={handleClose}>
      <div
        className="bottom-sheet trip-notes-sheet"
        ref={sheetRef}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Trip notes"
      >
        <div className="bottom-sheet-handle" {...handleProps} />

        <div className="sheet-header-row">
          <h2 className="bottom-sheet-title">Notes</h2>
          <button className="sheet-close" onClick={handleClose} aria-label="Close"><X size={20} /></button>
        </div>

        <section className="notes-block">
          <h3 className="pick-section-label">For the whole trip</h3>

          {editing ? (
            <div className="notes-editor">
              <textarea
                ref={textareaRef}
                className="input notes-textarea"
                placeholder="Anything that isn't about one place — arrival times, booking references, what to pack. Type @ to link a place."
                value={notes}
                autoFocus
                onChange={e => { setNotes(e.target.value); setDirty(true); setCaret(e.target.selectionStart ?? 0); }}
                onKeyUp={syncCaret}
                onClick={syncCaret}
                onKeyDown={onKeyDown}
                onBlur={() => { if (dirty) { onSaveNotes(notes.trim() || null); setDirty(false); } }}
              />
              {showSuggestions && (
                <ul className="mention-suggestions">
                  {suggestions.map((p, i) => (
                    <li key={p.id}>
                      <button
                        className={`mention-suggestion ${i === suggestIndex ? 'mention-suggestion--active' : ''}`}
                        // onMouseDown, not onClick: onClick fires after the
                        // textarea's blur, which would save and drop the popup
                        // before the insertion ever runs.
                        onMouseDown={e => { e.preventDefault(); insertMention(p); }}
                        type="button"
                      >
                        <AtSign size={14} />
                        <span className="mention-suggestion-name">{p.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="notes-hint">Type <strong>@</strong> to link a place</p>
            </div>
          ) : (
            <button className="notes-rendered" onClick={() => setEditing(true)} type="button">
              {parseMentions(notes, places).map((seg, i) =>
                seg.type === 'mention' && seg.place ? (
                  <span
                    key={i}
                    className="mention-chip"
                    role="link"
                    tabIndex={0}
                    onClick={e => { e.stopPropagation(); jumpToPlace(seg.place!.id); }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); jumpToPlace(seg.place!.id); }
                    }}
                  >
                    @{seg.value}
                  </span>
                ) : (
                  <span key={i}>{seg.value}</span>
                )
              )}
            </button>
          )}
        </section>

        <section className="notes-block">
          <h3 className="pick-section-label">By place</h3>
          {withNotes.length === 0 ? (
            <p className="pick-status">
              No place has notes yet. Open a place and add one — it'll show up here.
            </p>
          ) : (
            <ul className="place-notes-list">
              {withNotes.map(place => (
                <li key={place.id}>
                  <button className="place-note" onClick={() => jumpToPlace(place.id)} type="button">
                    <span className="place-note-head">
                      <span className="place-note-name">{place.name}</span>
                      {tagsOf(place).length > 0 && (
                        <span className="place-note-tags">
                          {tagsOf(place).map(t => (
                            <span key={t.id} className="place-note-tag" style={{ background: t.color }}>
                              {t.icon ? `${t.icon} ` : ''}{t.name}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                    <span className="place-note-body">{place.notes}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {withNotes.length === 0 && !notes.trim() && (
          <p className="notes-empty">
            <NotebookPen size={16} />
            Everything you write down for this trip collects here.
          </p>
        )}
      </div>
    </div>
  );
}
