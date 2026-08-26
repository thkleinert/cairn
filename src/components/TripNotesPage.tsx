import { ArrowLeft, NotebookPen, Plus, Minus, X } from 'lucide-react';
import { useState } from 'react';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { NoteList } from './NoteList';
import { TripTimeline } from './TripTimeline';
import { groupPlaces } from '../lib/placeTree';
import { nearestParent } from '../lib/anchor';
import type { Place, PlaceVisit, Tag, TripNote } from '../types';

// The trip-wide section folds like any other, but has no place id to key that
// on. A constant is safe: the stored set is already scoped to one trip, and
// this can't collide with a uuid.
const TRIP_WIDE = 'trip-wide';
// Same trick for the timeline, which is a section on this page without being
// a place either.
const TIMELINE = 'timeline';

interface Props {
  places: Place[];
  allTags: Tag[];
  /** Every dated visit in the trip — the timeline strip is built from these. */
  visits: PlaceVisit[];
  tripNotes: TripNote[];
  notesByPlace: Map<string, TripNote[]>;
  loading: boolean;
  onAdd: (
    body: string,
    placeId: string | null,
    opts: { depth: number; afterId: string | null },
  ) => Promise<TripNote | null> | void;
  onUpdate: (id: string, body: string) => Promise<unknown> | void;
  onRemove: (id: string) => Promise<boolean | void> | boolean | void;
  onRestore: (note: TripNote) => Promise<boolean | void> | boolean | void;
  onSetDepths: (updates: { id: string; depth: number }[]) => Promise<unknown> | void;
  onReorder: (orderedIds: string[]) => void | boolean | Promise<void | boolean>;
  onSelectPlace: (placeId: string) => void;
  /** Fold state, owned by the trip so it survives the page closing and reopening. */
  isCollapsed: (id: string) => boolean;
  toggleCollapse: (id: string) => void;
  /** Bullets keep their own fold state — a bullet is not a section. */
  isNoteFolded: (id: string) => boolean;
  toggleNoteFold: (id: string) => void;
  onExpandNote: (id: string) => void;
  /** Accepting a "looks like it's in X" suggestion. */
  onAnchorPlace: (childId: string, parentId: string) => void;
  isAnchorDismissed: (placeId: string) => boolean;
  onDismissAnchor: (placeId: string) => void;
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
// can do with a section: go to the place, write in it, or fold it. They are
// split by what each part of the row already means — see renderPlace.
//
// Every place gets a heading, including ones with nothing written under them
// yet. They cost a line each on a long trip, but omitting them made the page a
// reading surface you could only write to for places you had already written
// about — to add the first note to a place you had to find it on the map
// instead. An empty place is just its heading: no bullet, no prompt.
export function TripNotesPage({
  places, allTags, visits, tripNotes, notesByPlace, loading,
  onAdd, onUpdate, onRemove, onRestore, onSetDepths, onReorder, onSelectPlace,
  isCollapsed, toggleCollapse, isNoteFolded, toggleNoteFold, onExpandNote,
  onAnchorPlace, isAnchorDismissed, onDismissAnchor, onClose,
}: Props) {
  useEscapeClose(onClose);

  // Which section's heading was tapped to start a note. Cleared as soon as the
  // list has opened one, so tapping the same heading again opens another.
  const [addingFor, setAddingFor] = useState<string | null>(null);

  const tagsOf = (place: Place) =>
    allTags.filter(t => (place.tags ?? []).some(pt => pt.id === t.id));

  const { top: unsortedTop, childrenOf } = groupPlaces(places);

  // Alphabetical, and only here. The list view is the itinerary — its order is
  // dragged by hand and means something — whereas this page is looked things
  // up in, and a name is what you look up by. localeCompare rather than a raw
  // comparison so "Österreich" and "Zurich" land where a reader expects.
  const byName = (a: Place, b: Place) => a.name.localeCompare(b.name);
  const top = [...unsortedTop].sort(byName);
  const sortedChildren = (id: string) => [...(childrenOf.get(id) ?? [])].sort(byName);
  // Same rule as a place section: with nothing written there is nothing to
  // fold, and nothing that can be left folded.
  const tripWideCollapsed = tripNotes.length > 0 && isCollapsed(TRIP_WIDE);

  // One place's section: its heading, then its bullets.
  //
  // The heading is three targets, split by what each part of it already means
  // rather than by adding icons to say so: the NAME is the place, so tapping
  // the words goes there; the BLANK SPACE after the name is an empty line, so
  // tapping it starts writing on one; and the fold sits on the right where
  // every other fold in the app is. Nothing is overloaded and nothing needs a
  // chevron to explain it — which is also what let every place drop its
  // standing "Add a note…" bullet.
  const renderPlace = (place: Place, anchored: boolean) => {
    const notes = notesByPlace.get(place.id) ?? [];
    const childCount = (childrenOf.get(place.id) ?? []).length;
    // The RAW pointer, not the derived count above. setPlaceParent refuses to
    // move anything that holds places, and it asks the pointer — so a place
    // whose child groupPlaces declines to nest (an invalid parent chain) has
    // childCount 0 here and a child there, and the suggestion below would
    // offer a move whose only possible outcome is a toast saying no.
    const holdsPlaces = places.some(p => p.parent_place_id === place.id);
    // Nothing under it, nothing to fold — a control that can only toggle
    // emptiness is furniture. Bullets and list rows already worked this way;
    // headings were the odd one out.
    const foldable = notes.length > 0 || childCount > 0;
    // And a section that cannot be folded cannot be left folded. Without this,
    // collapsing a place and then deleting its last note would strand it: the
    // stored flag still says shut, and the control that would open it is gone.
    const collapsed = foldable && isCollapsed(place.id);
    // Only for places still at the top level, only until waved away — and
    // never for a place that holds other places. setPlaceParent refuses that
    // move (a stop cannot become a spot while it still has spots in
    // it), so offering it puts up a button whose only possible outcome is a
    // toast saying no. The list view already declines to draw the drag grip
    // for the same reason; this is the same rule on the other screen.
    const suggestion = anchored || holdsPlaces || isAnchorDismissed(place.id)
      ? null
      : nearestParent(place, places);

    return (
      <section
        className={[
          'notes-block',
          anchored ? 'notes-block--anchored' : '',
          childCount > 0 ? 'notes-block--has-children' : '',
        ].filter(Boolean).join(' ')}
        key={place.id}
      >
        <h2 className="notes-heading notes-heading--foldable">
          {/* Every heading is a bullet, because on this page everything is:
              the page is one outline, and a place is simply a bullet whose
              children happen to be notes and other places. Reusing the
              bullet's own class rather than copying its measurements is what
              keeps the two from drifting apart the next time either moves. */}
          <span
            className={`note-bullet-dot notes-heading-dot ${collapsed ? 'note-bullet-dot--folded' : ''}`}
            aria-hidden="true"
          />
          {/* The name is the place: tapping the words themselves goes there.
              A chevron saying so was redundant once the text does it, and it
              cost a target's width on every heading. */}
          <button
            type="button"
            className="notes-heading-link"
            aria-label={`Open ${place.name}`}
            onClick={() => onSelectPlace(place.id)}
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

          {/* Everything after the name is blank line waiting to be written on,
              which is exactly what tapping it does. It keeps a minimum width so
              a long place name can never squeeze the way-in down to nothing. */}
          <button
            type="button"
            className="notes-heading-space"
            aria-label={`Add a note to ${place.name}`}
            // Reads the stored flag, not the derived `collapsed`. A place
            // folded while it had notes, then emptied, keeps the flag set
            // while showing no control to clear it — writing here would
            // otherwise fold the section shut the instant the note landed and
            // made it foldable again.
            onClick={() => { if (isCollapsed(place.id)) toggleCollapse(place.id); setAddingFor(place.id); }}
          />

          {/* Fold sits on the right, as a plus or a minus, the same control a
              note bullet and a list row use. */}
          {foldable && (
            <button
              type="button"
              className="notes-fold"
              aria-label={collapsed ? `Expand ${place.name}` : `Collapse ${place.name}`}
              aria-expanded={!collapsed}
              onClick={() => toggleCollapse(place.id)}
            >
              {collapsed ? <Plus size={16} /> : <Minus size={16} />}
            </button>
          )}
        </h2>

        {/* "Looks like it's in Bangkok." Offered, never applied — a place
            already sitting at the top level was put there by someone, and a
            heuristic good enough to guess is not good enough to overrule that.
            New places are anchored outright instead, where there is nothing to
            overrule. */}
        {!anchored && suggestion && (
          <div className="anchor-hint">
            <span className="anchor-hint-text">
              Looks like it&rsquo;s in <strong>{suggestion.name}</strong>
            </span>
            <button
              type="button"
              className="anchor-hint-accept"
              onClick={() => onAnchorPlace(place.id, suggestion.id)}
            >
              Move it
            </button>
            <button
              type="button"
              className="anchor-hint-dismiss"
              aria-label={`Leave ${place.name} where it is`}
              onClick={() => onDismissAnchor(place.id)}
            >
              <X size={15} />
            </button>
          </div>
        )}

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
            isCollapsed={isNoteFolded}
            onToggleCollapse={toggleNoteFold}
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
    <div className="notes-page" role="dialog" aria-modal="true" aria-label="Trip outliner">
      <div className="trip-topbar">
        <button className="btn-icon" onClick={onClose} aria-label="Back">
          <ArrowLeft size={22} />
        </button>
        <h1 className="trip-topbar-title">Trip Outliner</h1>
      </div>

      <div className="notes-page-body">
        {/* Above General, because when a trip has dates they are the first
            thing anyone opening this page wants — and because everything
            below is sorted by name, which reads a trip in an order it never
            happens in. Draws nothing at all until something is dated. */}
        <TripTimeline
          visits={visits}
          places={places}
          collapsed={isCollapsed(TIMELINE)}
          onToggle={() => toggleCollapse(TIMELINE)}
          onSelectPlace={onSelectPlace}
        />

        {/* Wrapped, not doubly-classed: .notes-group and .notes-block both
            set margin-bottom at equal specificity, so putting both on one
            element let the later rule win and swallowed the gap after this
            section. The place groups below have the same shape. */}
        <div className="notes-group">
        <section className="notes-block">
          <h2 className="notes-heading notes-heading--foldable">
            <span
              className={`note-bullet-dot notes-heading-dot ${tripWideCollapsed ? 'note-bullet-dot--folded' : ''}`}
              aria-hidden="true"
            />
            {/* Nowhere for these words to lead — there is no page for the
                general section — so the whole line means "write here". */}
            <button
              type="button"
              className="notes-heading-link"
              aria-label="Add a general note"
              onClick={() => {
                if (isCollapsed(TRIP_WIDE)) toggleCollapse(TRIP_WIDE);
                setAddingFor(TRIP_WIDE);
              }}
            >
              <span className="notes-heading-name">General</span>
            </button>
            {/* Same blank remainder as a place heading, so the fold lands on
                the same axis and the row is written on the same way. There is
                nowhere for the words themselves to lead here, so both halves
                start a note rather than one of them navigating. */}
            <button
              type="button"
              className="notes-heading-space"
              aria-label="Add a general note"
              onClick={() => {
                if (isCollapsed(TRIP_WIDE)) toggleCollapse(TRIP_WIDE);
                setAddingFor(TRIP_WIDE);
              }}
            />
            {tripNotes.length > 0 && (
              <button
                type="button"
                className="notes-fold"
                aria-label={tripWideCollapsed ? 'Expand trip notes' : 'Collapse trip notes'}
                aria-expanded={!tripWideCollapsed}
                onClick={() => toggleCollapse(TRIP_WIDE)}
              >
                {tripWideCollapsed ? <Plus size={16} /> : <Minus size={16} />}
              </button>
            )}
          </h2>

          {tripWideCollapsed && (
            <button type="button" className="notes-folded-hint" onClick={() => toggleCollapse(TRIP_WIDE)}>
              {tripNotes.length} note{tripNotes.length === 1 ? '' : 's'}
            </button>
          )}

          {!tripWideCollapsed && (
          <NoteList
            notes={tripNotes}
            places={places}
            onAdd={(body, opts) => onAdd(body, null, opts)}
            onUpdate={onUpdate}
            onRemove={onRemove}
            onRestore={onRestore}
            onSetDepths={onSetDepths}
            onReorder={onReorder}
            isCollapsed={isNoteFolded}
            onToggleCollapse={toggleNoteFold}
            onExpand={onExpandNote}
            startDraft={addingFor === TRIP_WIDE}
            onDraftStarted={() => setAddingFor(null)}
            onSelectPlace={onSelectPlace}
          />
          )}
        </section>
        </div>

        {top.map(place => (
          <div className="notes-group" key={place.id}>
            {renderPlace(place, false)}
            {/* Places anchored to this one, nested under it rather than each
                claiming a top-level section. Folded away with their parent. */}
            {!isCollapsed(place.id) &&
              sortedChildren(place.id).map(child => renderPlace(child, true))}
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
