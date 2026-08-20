import type { Place } from '../types';

/**
 * Split places into the ones that stand alone and the children anchored to
 * each of them — a café under the city it is in.
 *
 * One level, deliberately. A place whose parent is itself anchored is treated
 * as top-level, which keeps the page readable on a phone and, more usefully,
 * means a cycle (a inside b, b inside a) renders as two ordinary headings
 * rather than as two places that appear nowhere. A parent that isn't in this
 * trip's places at all is treated the same way.
 */
export function groupPlaces<T extends { id: string; parent_place_id?: string | null; kind?: string }>(
  places: T[],
): { top: T[]; childrenOf: Map<string, T[]> } {
  const byId = new Map(places.map(p => [p.id, p]));
  const isAnchored = (p: T) => {
    const parent = p.parent_place_id ? byId.get(p.parent_place_id) : undefined;
    if (!parent || parent.id === p.id) return false;
    // A parent must be a stop. The database can only guarantee that anything
    // anchored is a location, not that what it points at is a stop, so this is
    // where the other half is enforced — by declining to nest, which shows up
    // as an unnested place rather than as one that renders nowhere.
    if (parent.kind !== undefined && parent.kind !== 'stop') return false;
    return !parent.parent_place_id;
  };

  const top: T[] = [];
  const childrenOf = new Map<string, T[]>();
  for (const place of places) {
    if (!isAnchored(place)) { top.push(place); continue; }
    const key = place.parent_place_id!;
    const list = childrenOf.get(key);
    if (list) list.push(place); else childrenOf.set(key, [place]);
  }
  return { top, childrenOf };
}


// Flattening a trip's stops and the locations inside them into the single
// ordered list the list view actually renders, and working out what a drop
// means once one of those rows is dragged somewhere else.
//
// Kept apart from the component because it is the part with rules rather than
// pixels: what a row is allowed to become, and which stop it lands in.

export interface FlatRow {
  place: Place;
  /** 0 for a stop, 1 for a location inside one. */
  depth: number;
  /** Locations under this stop, whether or not they are currently shown. */
  childCount: number;
}

/**
 * Stops in order, each followed by its locations.
 *
 * A folded stop keeps its own row and drops its children, so folding changes
 * what is on screen without changing the order anything is stored in.
 *
 * Locations whose stop was deleted come back as top-level rows. The database
 * nulls a child's parent when its stop goes (rather than deleting the child),
 * which leaves a location with nowhere to be — showing it at the top level is
 * the only alternative to hiding a place the user never asked to lose.
 */
export function flattenPlaces(
  places: Place[],
  isFolded: (id: string) => boolean = () => false,
): FlatRow[] {
  const { top, childrenOf } = groupPlaces(places);
  const rows: FlatRow[] = [];
  for (const place of top) {
    const children = childrenOf.get(place.id) ?? [];
    rows.push({ place, depth: 0, childCount: children.length });
    if (isFolded(place.id)) continue;
    for (const child of children) {
      rows.push({ place: child, depth: 1, childCount: 0 });
    }
  }
  return rows;
}

/**
 * Put the hidden rows back into an order taken from the screen.
 *
 * The list only renders — and so only reorders — what is visible, but a folded
 * stop's locations still have positions, and sending an order that omits them
 * would leave those positions describing a list they are no longer part of.
 * Each stop's children follow it, whether they were on screen or not.
 */
export function withHiddenChildren(orderedIds: string[], places: Place[]): string[] {
  const { childrenOf } = groupPlaces(places);
  const shown = new Set(orderedIds);
  const out: string[] = [];
  for (const id of orderedIds) {
    out.push(id);
    for (const child of childrenOf.get(id) ?? []) {
      // Skip the ones already in the list, or a child would appear twice.
      if (!shown.has(child.id)) out.push(child.id);
    }
  }
  return out;
}

/** Sideways travel needed before a drop re-nests rather than just reorders. */
export const INDENT_PX = 36;

export interface DropResult {
  /** The stop this row should now sit in, or null to make it a stop itself. */
  parentId: string | null;
  /** True when the drop changes nesting rather than only order. */
  changed: boolean;
}

/**
 * What a Notion-style drop means: where the row landed, and how far sideways
 * it was pulled getting there.
 *
 * Dragging right tucks a row under the nearest stop above where it was
 * dropped; dragging left pulls it back out to being a stop of its own. Below
 * the threshold in either direction the drop is a plain reorder and nesting is
 * left exactly as it was — which is what makes an ordinary vertical drag safe
 * on a list that happens to have hierarchy in it.
 *
 * The "nearest stop above" is taken from the order the drop produced, not the
 * one it started from, so dragging a row up past several stops puts it in the
 * one it visibly landed under.
 */
export function resolveDrop(
  orderedIds: string[],
  draggedId: string,
  sidewaysPx: number,
  places: Place[],
): DropResult {
  const byId = new Map(places.map(p => [p.id, p]));
  const dragged = byId.get(draggedId);
  if (!dragged) return { parentId: null, changed: false };

  const currentParent = dragged.parent_place_id ?? null;

  if (sidewaysPx <= -INDENT_PX) {
    // Pulled out. Already a stop means nothing to do.
    return { parentId: null, changed: currentParent !== null };
  }

  if (sidewaysPx >= INDENT_PX) {
    const at = orderedIds.indexOf(draggedId);
    // Walk back for something that can hold this row. A stop that is itself
    // nested cannot, and neither can another location — one level only, which
    // is what keeps a list you can still read at a glance.
    for (let i = at - 1; i >= 0; i--) {
      const above = byId.get(orderedIds[i]);
      if (!above) continue;
      if (above.kind === 'stop' && !above.parent_place_id) {
        return { parentId: above.id, changed: currentParent !== above.id };
      }
    }
    // Nothing above to go into — the first row of a list cannot be indented.
    return { parentId: currentParent, changed: false };
  }

  return { parentId: currentParent, changed: false };
}
