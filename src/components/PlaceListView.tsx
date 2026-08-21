import { useRef, useMemo } from 'react';
import { CheckCircle, Circle, MapPin, GripVertical, Plus, Minus } from 'lucide-react';
import type { Place, Tag } from '../types';
import { useDragReorder } from '../hooks/useDragReorder';
import { flattenPlaces, resolveDrop, withHiddenChildren, locationStaysWithParent, INDENT_PX } from '../lib/placeTree';

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
  /** Force a row open — used after a drop nests something inside a folded stop. */
  onExpandFold: (id: string) => void;
}

export function PlaceListView({
  places, activeTags, allTags, onSelectPlace, onReorder, onSetParent,
  isFolded, onToggleFold, onExpandFold,
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

  // Dragging moves one row, never a subtree. A FOLDED stop is fine —
  // withHiddenChildren re-attaches its locations to wherever it landed — but
  // an EXPANDED one is not: the drop writes an order with the stop moved and
  // its children left behind, and groupPlaces re-derives them straight back
  // underneath it, so the drag silently does nothing.
  //
  // Per row, not per list. Written as a list-wide flag this said "no row is
  // draggable if ANY expanded stop has children" — and since a location is
  // only ever a row at all when its parent is expanded, that meant the first
  // time you opened a stop to look inside it, every grip on the screen
  // disappeared: you could not reorder the cities below it, and you could
  // never drag a location at all, which made the drag-left-to-release half of
  // the gesture unreachable. Opening a stop is how you look at it, not a mode
  // that suspends the list.
  //
  // The handle is hidden rather than made inert on the rows this does exclude:
  // a grip that can be held and dragged and then changes nothing is worse than
  // no grip.
  const draggableIds = useMemo(
    () => new Set(
      rows
        .filter(r => canReorder && !(r.depth === 0 && r.childCount > 0 && !isFolded(r.place.id)))
        .map(r => r.place.id),
    ),
    [rows, canReorder, isFolded],
  );

  const {
    order, projectedOrder, dragId, dragLevel, suppressTransition,
    handlePointerDown, handlePointerMove, handlePointerUp, getRowOffsetPx,
  } = useDragReorder({
    items: rowPlaces,
    getId: p => p.id,
    // Dragging moves one row, never a subtree. A FOLDED stop is fine —
    // withHiddenChildren re-attaches its locations to wherever it landed — but
    // an expanded one is not: the drop writes an order with the stop moved and
    // its children left behind, and groupPlaces then re-derives them straight
    // back underneath it, so the drag silently does nothing. NoteList refuses
    // to drag at all once anything is nested, for this same reason.
    enabled: canReorder,
    trackSideways: true,
    sidewaysStep: INDENT_PX,
    onReorder: (orderedIds, sidewaysPx = 0) => {
      const drop = resolveDrop(orderedIds, dragId ?? '', sidewaysPx, places);

      // Order first, and without awaiting anything before it. The drag hook
      // drops its own copy of the order on release and falls back to `items`,
      // so `places` has to be updated in this same tick — both handlers below
      // are optimistic, so it is. Awaiting the re-nest first, as this did,
      // left the list showing the pre-drag order for a whole round trip and
      // then jumping again when the write returned.
      //
      // Nothing is lost by not sequencing them: one writes `position` and the
      // other writes `parent_place_id`, so the two cannot disagree about a
      // field. They can still interleave — reorderPlaces' realtime event can
      // trigger a refetch that lands between setPlaceParent's optimistic
      // update and its own write, briefly showing the old nesting — but that
      // resolves itself the moment the update's response arrives, which is a
      // flicker rather than the guaranteed round-trip-long wrong order that
      // awaiting the re-nest first produced on every single drop.
      //
      // A purely sideways drag leaves the order untouched, and writing an
      // unchanged order is a round trip whose refetch can only undo what just
      // happened.
      const full = withHiddenChildren(orderedIds, places);
      const before = places.map(p => p.id);
      const orderChanged =
        full.length !== before.length || full.some((id, i) => id !== before[i]);
      // A location dragged out of its own stop's run, without the sideways
      // travel that would re-nest it, is a move the next render undoes. Writing
      // it anyway cost a round trip, a broadcast to every collaborator, and a
      // stored order with one stop's children interleaved into another's.
      const keepsItsSlot = drop.changed || !dragId ||
        locationStaysWithParent(full, dragId, places);
      if (orderChanged && keepsItsSlot) onReorder(full);

      if (drop.changed && dragId) {
        void onSetParent(dragId, drop.parentId);
        // Otherwise the row just dragged into a folded stop simply vanishes,
        // and the only sign of where it went is the stop's count going up by
        // one. Adding a place already opens its stop for this reason.
        if (drop.parentId) onExpandFold(drop.parentId);
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

  // What letting go right now would actually do. Derived from resolveDrop
  // rather than from the sideways distance alone, because the two disagree in
  // exactly the cases a user is most likely to try: dragging a stop that holds
  // locations (it cannot become a location itself), and dragging the top row
  // right (there is nothing above to go into). Both were drawn with the accent
  // outline and the indent, promising a nest, and both then did nothing at all
  // on release — no movement, no toast, no reason given.
  const previewDrop = useMemo(
    () => (dragId && dragLevel !== 0
      ? resolveDrop(projectedOrder.map(p => p.id), dragId, dragLevel * INDENT_PX, places)
      : null),
    [dragId, dragLevel, projectedOrder, places],
  );

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
    <ul
      className={`place-list ${suppressTransition ? 'place-list--reordering' : ''}`}
      // One number for both: how far sideways re-nests a row, and how far in a
      // nested row sits. They were 36px and 26px, so a row dragged far enough
      // to nest landed somewhere it had never been shown.
      style={{ '--place-indent': `${INDENT_PX}px` } as React.CSSProperties}
    >
      {filtered.map((place, index) => {
        const isVisited = place.status === 'visited';
        const offsetPx = canReorder ? getRowOffsetPx(index, place.id) : 0;
        const depth = canReorder ? depthOf(place.id) : 0;
        const children = canReorder ? childCountOf(place.id) : 0;
        const dragging = dragId === place.id;
        // While a row is being dragged sideways, show the level it would land
        // at rather than the one it came from — the point of following the
        // finger is that you can see what letting go will do. A drop that
        // resolveDrop will refuse shows no change, because that is what will
        // happen.
        const previewDepth = dragging && previewDrop?.changed
          ? (previewDrop.parentId ? 1 : 0)
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
              // The row being dragged keeps its real indent. Its transform is
              // already carrying it sideways under the finger, so changing the
              // padding underneath it too moved the content by dx PLUS a full
              // indent — at the threshold it jumped 38px in one frame and sat
              // 34px past where a nested row actually settles. The accent
              // outline says what the drop will do; the finger says where.
              '--place-depth': dragging ? depth : previewDepth,
            } as React.CSSProperties}
          >
            {draggableIds.has(place.id) && (
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
            {/* The grip's column is held open on a row that has none, so an
                expanded stop does not sit 34px left of its own siblings.
                Reserving the space is what lets the handle be per-row at all —
                hiding it used to be safe only because it was hidden on every
                row at once. */}
            {canReorder && !draggableIds.has(place.id) && (
              <span className="place-list-drag-handle place-list-drag-handle--empty" aria-hidden="true" />
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
