import { useRef, useMemo } from 'react';
import { CheckCircle, Circle, MapPin, Plus, Minus } from 'lucide-react';
import type { Place, PlaceVisit, Tag } from '../types';
import { useDragReorder } from '../hooks/useDragReorder';
import { useLongPressDrag } from '../hooks/useLongPressDrag';
import { visitsForPlace, formatVisit, baseYear } from '../lib/timeline';
import { flattenPlaces, resolveDrop, withHiddenChildren, spotStaysWithParent, INDENT_PX } from '../lib/placeTree';

interface Props {
  places: Place[];
  activeTags: string[];
  allTags: Tag[];
  /**
   * Every dated visit in the trip. Filtered per row rather than pre-grouped
   * because the shared read-only view has no visits at all, and an absent
   * prop should mean "no dates", not a missing map.
   */
  visits?: PlaceVisit[];
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
  places, activeTags, allTags, visits = [], onSelectPlace, onReorder, onSetParent,
  isFolded, onToggleFold, onExpandFold,
}: Props) {
  // Reordering only makes sense against the full, unfiltered order.
  const canReorder = activeTags.length === 0;
  const rowRefs = useRef<Record<string, HTMLLIElement | null>>({});

  // Grouped once rather than filtered inside the row, which renders on every
  // frame of a drag. Stops only: a spot sits under a stop that already shows
  // the window, and repeating it on every café under it is noise — the whole
  // reason only stops can be dated in the first place.
  const visitsByPlace = useMemo(() => {
    const map = new Map<string, PlaceVisit[]>();
    if (visits.length === 0) return map;
    for (const place of places) {
      if (place.kind !== 'stop') continue;
      const own = visitsForPlace(visits, place.id);
      if (own.length > 0) map.set(place.id, own);
    }
    return map;
  }, [places, visits]);
  const year = useMemo(() => baseYear(visits), [visits]);

  // Stops with their spots under them, folded ones collapsed away. The
  // drag operates on exactly this list, so what you grab and what moves are
  // the same thing even when half the trip is folded shut.
  const rows = useMemo(
    () => flattenPlaces(places, isFolded),
    [places, isFolded],
  );
  const rowPlaces = useMemo(() => rows.map(r => r.place), [rows]);

  // Dragging moves one row, never a subtree. A FOLDED stop is fine —
  // withHiddenChildren re-attaches its spots to wherever it landed — but
  // an EXPANDED one is not: the drop writes an order with the stop moved and
  // its children left behind, and groupPlaces re-derives them straight back
  // underneath it, so the drag silently does nothing.
  //
  // Per row, not per list. Written as a list-wide flag this said "no row is
  // draggable if ANY expanded stop has children" — and since a spot is
  // only ever a row at all when its parent is expanded, that meant the first
  // time you opened a stop to look inside it, every grip on the screen
  // disappeared: you could not reorder the cities below it, and you could
  // never drag a spot at all, which made the drag-left-to-release half of
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
    // withHiddenChildren re-attaches its spots to wherever it landed — but
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
      // A spot dragged out of its own stop's run, without the sideways
      // travel that would re-nest it, is a move the next render undoes. Writing
      // it anyway cost a round trip, a broadcast to every collaborator, and a
      // stored order with one stop's children interleaved into another's.
      const keepsItsSlot = drop.changed || !dragId ||
        spotStaysWithParent(full, dragId, places);
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

  // No grab handle: a press held on the row itself becomes the drag, and any
  // travel before it lands leaves the gesture to the list's own scrolling.
  const press = useLongPressDrag({
    enabled: canReorder,
    onMove: handlePointerMove,
    onEnd: handlePointerUp,
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
  // spots (it cannot become a spot itself), and dragging the top row
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
            onPointerDown={e => {
              const row = rowRefs.current[place.id];
              if (!row || !draggableIds.has(place.id)) return;
              // The fold control and the status marker's strip both sit inside
              // this row, so their presses bubble up here. Neither should pick
              // it up: holding the fold to expand a stop lifted the whole row,
              // and the marker's strip is the leading edge a thumb rests on.
              // The old grip was immune to this only by being a separate
              // element with the handlers on it.
              const on = (sel: string) => (e.target as HTMLElement).closest(sel);
              if (on('.place-list-fold') || on('.place-list-status-zone')) return;
              // The press's own coordinates travel with it — by the time the
              // hold lands, this event is gone. See useLongPressDrag.
              press.start(e, point => handlePointerDown(place.id, index, row, point));
            }}
            onPointerMove={press.move}
            onPointerUp={press.end}
            onPointerCancel={press.end}
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

            <button
              className="place-list-item-content"
              onClick={() => { if (!press.swallowedClick()) onSelectPlace(place); }}
            >
              {/* The status marker leads the row, ahead of the thumbnail —
                  it belongs to the place rather than to its name, and out here
                  it reads down the list as a column of its own. It also frees
                  the body: with nothing before the name, the name, the dates
                  and the tags share the body's own left edge and no longer
                  need an indent to line up. */}
              {/* Labelled, because shape and colour are the only other cues
                  it has: a check ring against an empty one, in text ink
                  against muted. Read aloud, both rows said the same thing, and
                  the single fact this marker exists to carry was the one thing
                  missing from it. It sits inside the row's button, so the
                  label joins that button's own name. */}
              {/* The marker sits in a zone that does not start a drag. It is
                  the strip a thumb rests on at the leading edge of a row, and
                  a press landing there is far more likely to be someone about
                  to scroll than someone about to reorder. Tapping it still
                  opens the place — the zone is inside the row's button, and
                  only the drag is suppressed. */}
              <span className="place-list-status-zone">
                {isVisited
                  ? <CheckCircle size={16} className="place-list-status" color="var(--color-text)" role="img" aria-label="Visited" />
                  : <Circle size={16} className="place-list-status" color="var(--color-muted)" role="img" aria-label="Not visited" />
                }
              </span>
              {place.image_url && (
                <img src={place.image_url} alt="" className="place-list-thumb" />
              )}
              <div className="place-list-body">
                <div className="place-list-top">
                  <span className="place-list-name">{place.name}</span>
                  {folded && children > 0 && (
                    <span className="place-list-folded-count">
                      {children} inside
                    </span>
                  )}
                </div>
                {/* A line of its own, under the name. It shared the name's
                    row while the address was still there and a dated place was
                    four lines tall; with the address gone the row can afford
                    one, and on its own line the dates compete with nothing —
                    which is also why every visit is spelled out again rather
                    than summarised. A city you come back to reads as
                    "24 – 25 Oct · 11 – 14 Nov", which is the fact worth seeing
                    at a glance and the reason a visit is a row in the database
                    rather than a pair of columns. */}
                {(visitsByPlace.get(place.id) ?? []).length > 0 && (() => {
                  const all = visitsByPlace.get(place.id)!
                    .map(v => formatVisit(v, year)).join(' · ');
                  return (
                    // The line still truncates — around four visits on a
                    // narrow screen — and having dropped the "+N" summary
                    // there is nothing left to say so. The title is only a
                    // courtesy to a desktop reader, since a phone has no
                    // hover; the full list lives on the place sheet and in
                    // the timeline. Set only when there is more than one
                    // visit, so it never just repeats the visible text.
                    <p
                      className="place-list-dates"
                      title={visitsByPlace.get(place.id)!.length > 1 ? all : undefined}
                    >
                      {all}
                    </p>
                  );
                })()}
                {/* No address line at all. For a stop it was the name back
                    again — "Surat Thani, Amphoe Mueang Surat Thani, Surat
                    Thani, Thailand" under a row already headed Surat Thani —
                    and for a spot it was a detail this screen is not for. The
                    list view is the itinerary: what, in what order, and when.
                    Where a place is, is what the map is, and the place sheet
                    prints the address in full next to a pin. */}
                {(place.tags ?? []).length > 0 && (
                  <div className="place-list-tags">
                    {(place.tags ?? []).map(tag => {
                      const full = allTags.find(t => t.id === tag.id);
                      return (
                        <span key={tag.id} className="tag-pill">
                          <span className="tag-pill-dot" style={{ background: full?.color ?? 'var(--color-muted)' }} />
                          {/* The label is its own element so it can ellipsise.
                              As a bare text node it was an anonymous flex item,
                              which nothing can target — so a long tag name had
                              no way to end and pushed the whole row wide. */}
                          <span className="tag-pill-label">{full?.name ?? tag.name}</span>
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
