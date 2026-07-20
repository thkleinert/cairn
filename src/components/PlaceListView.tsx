import { useRef } from 'react';
import { CheckCircle, Circle, MapPin, GripVertical } from 'lucide-react';
import type { Place, Tag } from '../types';
import { useDragReorder } from '../hooks/useDragReorder';

interface Props {
  places: Place[];
  activeTags: string[];
  allTags: Tag[];
  onSelectPlace: (place: Place) => void;
  onReorder: (orderedIds: string[]) => void;
}

export function PlaceListView({ places, activeTags, allTags, onSelectPlace, onReorder }: Props) {
  // Reordering only makes sense against the full, unfiltered order
  const canReorder = activeTags.length === 0;
  const rowRefs = useRef<Record<string, HTMLLIElement | null>>({});

  const { order, dragId, suppressTransition, handlePointerDown, handlePointerMove, handlePointerUp, getRowOffsetPx } =
    useDragReorder({ items: places, getId: p => p.id, onReorder, enabled: canReorder });

  const filtered = canReorder
    ? order
    : places.filter(p => (p.tags ?? []).some(t => activeTags.includes(t.id)));

  if (filtered.length === 0) {
    return (
      <div className="empty-state list-empty">
        <MapPin size={40} color="var(--color-muted)" />
        <p>{activeTags.length > 0 ? 'No places match this filter' : 'No places yet — search to add one'}</p>
      </div>
    );
  }

  return (
    <ul className={`place-list ${suppressTransition ? 'place-list--reordering' : ''}`}>
      {filtered.map((place, index) => {
        const isVisited = place.status === 'visited';
        const offsetPx = canReorder ? getRowOffsetPx(index, place.id) : 0;
        return (
          <li
            key={place.id}
            ref={el => { rowRefs.current[place.id] = el; }}
            className={`place-list-item ${dragId === place.id ? 'place-list-item--dragging' : ''}`}
            style={offsetPx ? { transform: `translateY(${offsetPx}px)` } : undefined}
          >
            {canReorder && (
              <button
                className="place-list-drag-handle"
                aria-label={`Reorder ${place.name}`}
                onPointerDown={e => {
                  const row = rowRefs.current[place.id];
                  if (row) handlePointerDown(place.id, index, row, e);
                }}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
              >
                <GripVertical size={16} />
              </button>
            )}
            <button
              className={`place-list-item-content ${!canReorder ? 'place-list-item-content--flush' : ''}`}
              onClick={() => onSelectPlace(place)}
            >
              {place.image_url && (
                <img src={place.image_url} alt="" className="place-list-thumb" />
              )}
              <div className="place-list-body">
                <div className="place-list-top">
                  {isVisited
                    ? <CheckCircle size={16} color="var(--color-text)" />
                    : <Circle size={16} color="var(--color-muted)" />
                  }
                  <span className="place-list-name">{place.name}</span>
                </div>
                {place.address && <p className="place-list-address">{place.address}</p>}
                {(place.tags ?? []).length > 0 && (
                  <div className="place-list-tags">
                    {(place.tags ?? []).map(tag => {
                      const full = allTags.find(t => t.id === tag.id);
                      return (
                        <span key={tag.id} className="tag-pill">
                          <span className="tag-pill-dot" style={{ background: full?.color ?? 'var(--color-muted)' }} />
                          {full?.name ?? tag.name}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
