import { useRef, useMemo } from 'react';
import { CheckCircle, Circle, MapPin, GripVertical, Plus, Minus } from 'lucide-react';
import type { Place, Tag } from '../types';
import { useDragReorder } from '../hooks/useDragReorder';
import { flattenPlaces, resolveDrop, withHiddenChildren, INDENT_PX } from '../lib/placeTree';

interface Props {
  places: Place[];
  activeTags: string[];
  allTags: Tag[];
  onSelectPlace: (place: Place) => void;
  onReorder: (orderedIds: string[]) => void;
  /**
   * Re-nesting after a sideways drop. null makes the place a stop again.
   * Awaited before the reorder is written, so the two cannot race.
   */
  onSetParent: (placeId: string, parentId: string | null) => Promise<unknown> | void;
  isFolded: (id: string) => boolean;
  onToggleFold: (id: string) => void;
}

export function PlaceListView({
  places, activeTags, allTags, onSelectPlace, onReorder, onSetParent, isFolded, onToggleFold,
}: Props) {
  // Reordering only makes sense against the full, unfiltered order.
  const canReorder = activeTags.length === 0;
  const rowRefs = useRef<Record<string, HTMLLIElement | null>>({});

  // Stops with their locations under them, folded ones collapsed away. The
  // drag operates on exactly this list, so what you grab and what moves are
  // the same thing even when half the trip is folded shut.
  const rows = useMemo(
    () => flattenPlaces(places, isFolded),
    [places, isFolded],
  );
  const rowPlaces = useMemo(() => rows.map(r => r.place), [rows]);

  const {
    order, dragId, dragDx, suppressTransition,
    handlePointerDown, handlePointerMove, handlePointerUp, getRowOffsetPx,
  } = useDragReorder({
    items: rowPlaces,
    getId: p => p.id,
    enabled: canReorder,
    trackSideways: true,
    onReorder: async (orderedIds, sidewaysPx = 0) => {
      const drop = resolveDrop(orderedIds, dragId ?? '', sidewaysPx, places);

      // Re-nest first and wait for it. Both writes end in a refetch, and the
      // reorder's arriving first would describe the row as it was before it
      // moved out.
      if (drop.changed && dragId) await onSetParent(dragId, drop.parentId);

      // A purely sideways drag leaves the order untouched, and writing an
      // unchanged order is a round trip whose refetch can only undo what just
      // happened.
      const full = withHiddenChildren(orderedIds, places);
      const before = places.map(p => p.id);
      if (full.length !== before.length || full.some((id, i) => id !== before[i])) {
        onReorder(full);
      }
    },
  });

  const depthOf = useMemo(() => {
    const map = new Map(rows.map(r => [r.place.id, r.depth]));
    return (id: string) => map.get(id) ?? 0;
  }, [rows]);
  const childCountOf = useMemo(() => {
    const map = new Map(rows.map(r => [r.place.id, r.childCount]));
    return (id: string) => map.get(id) ?? 0;
  }, [rows]);

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
        const depth = canReorder ? depthOf(place.id) : 0;
        const children = canReorder ? childCountOf(place.id) : 0;
        const dragging = dragId === place.id;
        // While a row is being dragged sideways, show the level it would land
        // at rather than the one it came from — the point of following the
        // finger is that you can see what letting go will do.
        const previewDepth = dragging && dragDx >= INDENT_PX ? 1
          : dragging && dragDx <= -INDENT_PX ? 0
          : depth;
        const folded = isFolded(place.id);

        return (
          <li
            key={place.id}
            ref={el => { rowRefs.current[place.id] = el; }}
            className={[
              'place-list-item',
              dragging ? 'place-list-item--dragging' : '',
              dragging && previewDepth !== depth ? 'place-list-item--renesting' : '',
            ].filter(Boolean).join(' ')}
            style={{
              ...(offsetPx ? { transform: `translateY(${offsetPx}px)` } : undefined),
              '--place-depth': previewDepth,
            } as React.CSSProperties}
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
                  {folded && children > 0 && (
                    <span className="place-list-folded-count">
                      {children} inside
                    </span>
                  )}
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

            {/* Right-aligned plus/minus, the same control a note bullet and a
                notes-page heading use — "there is more under this" looks the
                same everywhere. Only a stop with something inside it gets one;
                a row with nothing to fold shows no control rather than a dead
                one. */}
            {canReorder && children > 0 && (
              <button
                className="place-list-fold"
                aria-label={folded ? `Expand ${place.name}` : `Collapse ${place.name}`}
                aria-expanded={!folded}
                onClick={() => onToggleFold(place.id)}
              >
                {folded ? <Plus size={15} /> : <Minus size={15} />}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
