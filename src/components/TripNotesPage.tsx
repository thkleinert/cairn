import { ArrowLeft, NotebookPen, ChevronRight } from 'lucide-react';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { NoteList } from './NoteList';
import type { Place, Tag, TripNote } from '../types';

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
// A place's name IS its heading, and tapping it opens the place — the detail
// sheet layers over this page rather than replacing it, so dismissing it comes
// back to the same scroll position.
//
// Every place gets a heading, including ones with nothing written under them
// yet. They cost a line each on a long trip, but omitting them made the page a
// reading surface you could only write to for places you had already written
// about — to add the first note to a place you had to find it on the map
// instead. An empty place shows the same waiting bullet an empty list does, so
// the way in is identical wherever you are.
export function TripNotesPage({
  places, allTags, tripNotes, notesByPlace, loading,
  onAdd, onUpdate, onRemove, onRestore, onSetDepths, onReorder, onSelectPlace, onClose,
}: Props) {
  useEscapeClose(onClose);

  const tagsOf = (place: Place) =>
    allTags.filter(t => (place.tags ?? []).some(pt => pt.id === t.id));

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
          <h2 className="notes-heading">For the whole trip</h2>
          <NoteList
            notes={tripNotes}
            places={places}
            onAdd={(body, opts) => onAdd(body, null, opts)}
            onUpdate={onUpdate}
            onRemove={onRemove}
            onRestore={onRestore}
            onSetDepths={onSetDepths}
            onReorder={onReorder}
            onSelectPlace={onSelectPlace}
            placeholder="Add a general note…"
          />
        </section>

        {places.map(place => (
          <section className="notes-block" key={place.id}>
            <h2 className="notes-heading">
              <button
                type="button"
                className="notes-heading-link"
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
                <ChevronRight size={15} className="notes-heading-chevron" />
              </button>
            </h2>
            <NoteList
              notes={notesByPlace.get(place.id) ?? []}
              places={places}
              onAdd={(body, opts) => onAdd(body, place.id, opts)}
              onUpdate={onUpdate}
              onRemove={onRemove}
              onRestore={onRestore}
              onSetDepths={onSetDepths}
              onReorder={onReorder}
              onSelectPlace={onSelectPlace}
              placeholder="Add a note to this place…"
            />
          </section>
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
