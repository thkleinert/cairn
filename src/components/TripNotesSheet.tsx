import { X, NotebookPen, ChevronRight } from 'lucide-react';
import { useSwipeToClose } from '../hooks/useSwipeToClose';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { NoteList } from './NoteList';
import type { Place, Tag, TripNote } from '../types';

interface Props {
  places: Place[];
  allTags: Tag[];
  tripNotes: TripNote[];
  notesByPlace: Map<string, TripNote[]>;
  onAdd: (body: string, placeId?: string | null) => Promise<unknown> | void;
  onUpdate: (id: string, body: string) => Promise<unknown> | void;
  onRemove: (id: string) => Promise<unknown> | void;
  onReorder: (orderedIds: string[]) => void;
  onSelectPlace: (placeId: string) => void;
  onClose: () => void;
}

// Everything written down for a trip, in one place. The trip-wide bullets and
// each place sit at the same level: one heading, then its notes. A place's
// name IS its heading, and tapping it opens the place. Places without notes
// are omitted — on a long trip they'd be most of the page, and this is a
// reading surface.
export function TripNotesSheet({
  places, allTags, tripNotes, notesByPlace,
  onAdd, onUpdate, onRemove, onReorder, onSelectPlace, onClose,
}: Props) {
  const { sheetRef, handleProps } = useSwipeToClose(onClose);
  useEscapeClose(onClose);

  const withNotes = places.filter(p => (notesByPlace.get(p.id)?.length ?? 0) > 0);
  const tagsOf = (place: Place) =>
    allTags.filter(t => (place.tags ?? []).some(pt => pt.id === t.id));

  return (
    <div className="bottom-sheet-overlay" onClick={onClose}>
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
          <button className="sheet-close" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>

        <section className="notes-block">
          <h3 className="notes-heading">For the whole trip</h3>
          <NoteList
            notes={tripNotes}
            places={places}
            onAdd={(body) => onAdd(body, null)}
            onUpdate={onUpdate}
            onRemove={onRemove}
            onReorder={onReorder}
            onSelectPlace={onSelectPlace}
            addPlaceholder="Arrival times, booking refs… type @ to link a place"
          />
        </section>

        {withNotes.map(place => (
          <section className="notes-block" key={place.id}>
            <h3 className="notes-heading">
              <button
                type="button"
                className="notes-heading-link"
                onClick={() => onSelectPlace(place.id)}
              >
                <span className="notes-heading-name">{place.name}</span>
                {tagsOf(place).map(t => (
                  <span key={t.id} className="place-note-tag" style={{ background: t.color }}>
                    {t.icon ? `${t.icon} ` : ''}{t.name}
                  </span>
                ))}
                <ChevronRight size={15} className="notes-heading-chevron" />
              </button>
            </h3>
            <NoteList
              notes={notesByPlace.get(place.id) ?? []}
              places={places}
              onAdd={(body) => onAdd(body, place.id)}
              onUpdate={onUpdate}
              onRemove={onRemove}
              onReorder={onReorder}
              onSelectPlace={onSelectPlace}
              addPlaceholder="Add a note to this place…"
            />
          </section>
        ))}

        {withNotes.length === 0 && tripNotes.length === 0 && (
          <p className="notes-empty">
            <NotebookPen size={16} />
            Everything you write down for this trip collects here.
          </p>
        )}
      </div>
    </div>
  );
}
