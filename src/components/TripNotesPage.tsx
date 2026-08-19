import { ArrowLeft, NotebookPen, ChevronRight, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { NoteList } from './NoteList';
import { groupPlaces } from '../lib/outline';
import type { Place, Tag, TripNote } from '../types';

// The trip-wide section folds like any other, but has no place id to key that
// on. A constant is safe: the stored set is already scoped to one trip, and
// this can't collide with a uuid.
const TRIP_WIDE = 'trip-wide';

interface Props {
  places: Place[];
  allTags: Tag[];
  tripNotes: TripNote[];
  notesByPlace: Map<string, TripNote[]>;
  loading: boolean;
  onAdd: (
    body: string,
    placeId: string | null,
    opts: { depth: number; afterId: string | null },
  ) => Promise<TripNote | null> | void;
  onUpdate: (id: string, body: string) => Promise<unknown> | void;
  onRemove: (id: string) => Promise<unknown> | void;
  onRestore: (note: TripNote) => Promise<unknown> | void;
  onSetDepths: (updates: { id: string; depth: number }[]) => Promise<unknown> | void;
  onReorder: (orderedIds: string[]) => void;
  onSelectPlace: (placeId: string) => void;
  /** Fold state, owned by the trip so it survives the page closing and reopening. */
  isCollapsed: (id: string) => boolean;
  toggleCollapse: (id: string) => void;
  onExpandNote: (id: string) => void;
  onClose: () => void;
}

// Everything written down for a trip, as one full-screen outline: a list of
// lists. The trip-wide bullets and each place sit at the same level — one
// unbulleted heading, then its notes underneath.
//
// A full page rather than a bottom sheet because this is where a trip is
// actually read and written, not glanced at: a sheet caps out around 60dvh,
// and on a long trip that left the outline scrolling inside a window half the
// height of the screen it had available.
//
// A place's name IS its heading, and the heading carries all three things you
// can do with a section: fold it, write in it, or go to the place. Splitting
// them is what keeps the page quiet — see renderPlace.
//
// Every place gets a heading, including ones with nothing written under them
// yet. They cost a line each on a long trip, but omitting them made the page a
// reading surface you could only write to for places you had already written
// about — to add the first note to a place you had to find it on the map
// instead. An empty place is just its heading: no bullet, no prompt.
export function TripNotesPage({
  places, allTags, tripNotes, notesByPlace, loading,
  onAdd, onUpdate, onRemove, onRestore, onSetDepths, onReorder, onSelectPlace,
  isCollapsed, toggleCollapse, onExpandNote, onClose,
}: Props) {
  useEscapeClose(onClose);

  // Which section's heading was tapped to start a note. Cleared as soon as the
  // list has opened one, so tapping the same heading again opens another.
  const [addingFor, setAddingFor] = useState<string | null>(null);

  const tagsOf = (place: Place) =>
    allTags.filter(t => (place.tags ?? []).some(pt => pt.id === t.id));

  const { top, childrenOf } = groupPlaces(places);

  // One place's section: its heading, then its bullets.
  //
  // The heading is three targets, which is what resolves "tapping a heading
  // opens the place, so where do collapse and add-a-note go?" without
  // overloading anything: the leading caret folds, the line writes, the
  // trailing chevron travels. The chevron keeps the meaning it always had —
  // it was already the "go here" affordance — and taking navigation off the
  // rest of the row is what freed the line to be the way in for writing, which
  // in turn let every place drop its standing "Add a note…" bullet.
  const renderPlace = (place: Place, anchored: boolean) => {
    const notes = notesByPlace.get(place.id) ?? [];
    const collapsed = isCollapsed(place.id);
    const childCount = (childrenOf.get(place.id) ?? []).length;

    return (
      <section
        className={`notes-block ${anchored ? 'notes-block--anchored' : ''}`}
        key={place.id}
      >
        <h2 className="notes-heading notes-heading--foldable">
          <button
            type="button"
            className="notes-fold"
            aria-label={collapsed ? `Expand ${place.name}` : `Collapse ${place.name}`}
            aria-expanded={!collapsed}
            onClick={() => toggleCollapse(place.id)}
          >
            <ChevronDown
              size={16}
              className={`notes-fold-caret ${collapsed ? 'notes-fold-caret--closed' : ''}`}
            />
          </button>
          {/* Tapping the line writes; the chevron travels. Three targets on
              one row — fold, write, go — and each is the obvious size and
              place for what it does. This is also what let every place stop
              carrying a standing "Add a note…" row: the heading IS the way in,
              so an empty place needs nothing under it at all. */}
          <button
            type="button"
            className="notes-heading-link"
            aria-label={`Add a note to ${place.name}`}
            onClick={() => { if (collapsed) toggleCollapse(place.id); setAddingFor(place.id); }}
          >
            <span className="notes-heading-name">{place.name}</span>
            {tagsOf(place).length > 0 && (
              <span className="notes-heading-tags">
                {tagsOf(place).map(t => (
                  <span key={t.id} className="place-note-tag" style={{ background: t.color }}>
                    {t.icon ? `${t.icon} ` : ''}{t.name}
                  </span>
                ))}
              </span>
            )}
          </button>
          <button
            type="button"
            className="notes-heading-go"
            aria-label={`Open ${place.name}`}
            onClick={() => onSelectPlace(place.id)}
          >
            <ChevronRight size={17} />
          </button>
        </h2>

        {/* What a folded section is hiding, so it isn't just gone. */}
        {collapsed && (notes.length > 0 || childCount > 0) && (
          <button type="button" className="notes-folded-hint" onClick={() => toggleCollapse(place.id)}>
            {[
              notes.length > 0 ? `${notes.length} note${notes.length === 1 ? '' : 's'}` : null,
              childCount > 0 ? `${childCount} place${childCount === 1 ? '' : 's'}` : null,
            ].filter(Boolean).join(' · ')}
          </button>
        )}

        {!collapsed && (
          <NoteList
            notes={notes}
            places={places}
            onAdd={(body, opts) => onAdd(body, place.id, opts)}
            onUpdate={onUpdate}
            onRemove={onRemove}
            onRestore={onRestore}
            onSetDepths={onSetDepths}
            onReorder={onReorder}
            isCollapsed={isCollapsed}
            onToggleCollapse={toggleCollapse}
            onExpand={onExpandNote}
            startDraft={addingFor === place.id}
            onDraftStarted={() => setAddingFor(null)}
            onSelectPlace={onSelectPlace}
          />
        )}
      </section>
    );
  };

  return (
    <div className="notes-page" role="dialog" aria-modal="true" aria-label="Trip notes">
      <div className="trip-topbar">
        <button className="btn-icon" onClick={onClose} aria-label="Back">
          <ArrowLeft size={22} />
        </button>
        <h1 className="trip-topbar-title">Notes</h1>
      </div>

      <div className="notes-page-body">
        <section className="notes-block">
          <h2 className="notes-heading notes-heading--foldable">
            <button
              type="button"
              className="notes-fold"
              aria-label={isCollapsed(TRIP_WIDE) ? 'Expand trip notes' : 'Collapse trip notes'}
              aria-expanded={!isCollapsed(TRIP_WIDE)}
              onClick={() => toggleCollapse(TRIP_WIDE)}
            >
              <ChevronDown
                size={16}
                className={`notes-fold-caret ${isCollapsed(TRIP_WIDE) ? 'notes-fold-caret--closed' : ''}`}
              />
            </button>
            {/* No chevron: there is no page for "the whole trip" to open, so
                the line only ever means "write here". */}
            <button
              type="button"
              className="notes-heading-link"
              aria-label="Add a general note"
              onClick={() => {
                if (isCollapsed(TRIP_WIDE)) toggleCollapse(TRIP_WIDE);
                setAddingFor(TRIP_WIDE);
              }}
            >
              <span className="notes-heading-name">For the whole trip</span>
            </button>
          </h2>

          {isCollapsed(TRIP_WIDE) && tripNotes.length > 0 && (
            <button type="button" className="notes-folded-hint" onClick={() => toggleCollapse(TRIP_WIDE)}>
              {tripNotes.length} note{tripNotes.length === 1 ? '' : 's'}
            </button>
          )}

          {!isCollapsed(TRIP_WIDE) && (
          <NoteList
            notes={tripNotes}
            places={places}
            onAdd={(body, opts) => onAdd(body, null, opts)}
            onUpdate={onUpdate}
            onRemove={onRemove}
            onRestore={onRestore}
            onSetDepths={onSetDepths}
            onReorder={onReorder}
            isCollapsed={isCollapsed}
            onToggleCollapse={toggleCollapse}
            onExpand={onExpandNote}
            startDraft={addingFor === TRIP_WIDE}
            onDraftStarted={() => setAddingFor(null)}
            onSelectPlace={onSelectPlace}
          />
          )}
        </section>

        {top.map(place => (
          <div key={place.id}>
            {renderPlace(place, false)}
            {/* Places anchored to this one, nested under it rather than each
                claiming a top-level section. Folded away with their parent. */}
            {!isCollapsed(place.id) &&
              (childrenOf.get(place.id) ?? []).map(child => renderPlace(child, true))}
          </div>
        ))}

        {/* Only when the trip has no places either — with places listed, every
            one of them is already an invitation to write, and this line under
            them would be claiming the page is empty when it isn't.
            `loading` matters here: without it the page asserts the trip has
            nothing written down for the moment before the first fetch lands,
            so opening it always flashed this line. */}
        {!loading && places.length === 0 && tripNotes.length === 0 && (
          <p className="notes-empty">
            <NotebookPen size={16} />
            Everything you write down for this trip collects here.
          </p>
        )}
      </div>
    </div>
  );
}
