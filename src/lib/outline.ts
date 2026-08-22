import type { TripNote } from '../types';

// Outline shape rules for a flat, ordered bullet list carrying a `depth`.
//
// Bullets only. How places contain other places lives in placeTree.ts — it is
// a different tree with different rules (one level, parent must be a stop),
// and keeping the two in one file is how groupPlaces ended up here in the
// first place.
//
// There is no parent_id: a bullet's parent is the nearest bullet above it with
// a smaller depth, and its children are the unbroken run below it that are
// deeper. Everything here is derived from that one sentence.
//
// Pure functions over an ordered array, deliberately — the same rules have to
// hold for the editor, for the read-only shared view, and for whatever the
// database hands back after two people edited at once, and the cheapest way to
// guarantee that is to have one implementation none of them can skip.

/** Matches trip_notes_depth_bounded. Past this, indent costs more width than the text has. */
export const MAX_DEPTH = 5;

/**
 * Clamp a list to a shape an outline can actually have.
 *
 * A bullet may sit at most one level deeper than the one above it, and the
 * first is always at the outer edge. The database can hold a violation — two
 * collaborators indenting the same bullet at once each write a valid depth,
 * and the pair is invalid — so this runs on every render rather than trusting
 * stored values. A too-deep bullet is pulled in to the deepest legal level,
 * which reads as "not indented as far as I asked" instead of as a broken tree.
 */
export function normaliseDepths<T extends { depth: number }>(items: T[]): T[] {
  let previous = -1;
  return items.map(item => {
    // Coerce before comparing. A row from a database that has not had the
    // depth migration applied arrives with depth undefined, and undefined
    // through Math.min is NaN — which is not merely wrong, it is silently
    // catastrophic: every comparison against NaN is false, so canIndent,
    // canOutdent, canMoveUp and canMoveDown all say no, and the toolbar
    // presents a bullet that cannot be indented, outdented or moved while
    // delete (which never reads depth) stays live. Anything non-finite is
    // treated as the outer level, so an unmigrated or corrupt row renders as
    // a flat list that still works rather than one that is quietly inert.
    const raw = Number(item.depth);
    const safe = Number.isFinite(raw) ? raw : 0;
    const depth = Math.max(0, Math.min(safe, previous + 1, MAX_DEPTH));
    previous = depth;
    return depth === item.depth ? item : { ...item, depth };
  });
}

/**
 * The index just past the last descendant of `index`.
 * Descendants are the unbroken run of deeper bullets immediately below it, so
 * this is where the subtree ends and the next sibling (or uncle) begins.
 */
export function subtreeEnd(items: { depth: number }[], index: number): number {
  const depth = items[index]?.depth ?? 0;
  let end = index + 1;
  while (end < items.length && items[end].depth > depth) end += 1;
  return end;
}

/** A bullet and everything nested under it, in order. Moves travel together. */
export function subtree<T extends { depth: number }>(items: T[], index: number): T[] {
  return items.slice(index, subtreeEnd(items, index));
}

/**
 * Indenting makes a bullet a child of its previous sibling, so it needs one to
 * become a child of — the first bullet of a list can never indent. Going more
 * than one level past the bullet above would skip a level, which is the
 * invalid shape normaliseDepths exists to clamp, so it's refused here instead
 * of being written and silently pulled back.
 */
export function canIndent(items: { depth: number }[], index: number): boolean {
  if (index <= 0 || index >= items.length) return false;
  if (items[index].depth > items[index - 1].depth) return false;
  // The whole subtree moves, so it's the deepest descendant that hits the wall.
  const deepest = subtree(items, index).reduce((max, i) => Math.max(max, i.depth), 0);
  return deepest + 1 <= MAX_DEPTH;
}

/** Anything already at the outer edge has nowhere further out to go. */
export function canOutdent(items: { depth: number }[], index: number): boolean {
  return index >= 0 && index < items.length && items[index].depth > 0;
}

/**
 * The depth changes an indent/outdent implies: the bullet and every descendant
 * shift by the same delta, which is what keeps the subtree's internal shape
 * intact rather than flattening it against the moved parent.
 */
export function shiftSubtree(
  items: TripNote[], index: number, delta: 1 | -1,
): { id: string; depth: number }[] {
  return subtree(items, index).map(n => ({ id: n.id, depth: n.depth + delta }));
}

/**
 * Where the bullet's previous and next siblings start, or -1 for none.
 *
 * A sibling shares this bullet's depth with no shallower bullet in between —
 * a shallower one is the parent, and crossing it would move the bullet to a
 * different parent rather than reorder it within this one. Move up/down stays
 * inside the parent deliberately: an arrow that silently re-parents a bullet
 * is how an outline gets shuffled into a shape nobody asked for.
 */
export function siblings(items: { depth: number }[], index: number): { prev: number; next: number } {
  const depth = items[index]?.depth ?? 0;

  let prev = -1;
  for (let i = index - 1; i >= 0; i--) {
    if (items[i].depth < depth) break;        // hit the parent
    if (items[i].depth === depth) { prev = i; break; }
  }

  const after = subtreeEnd(items, index);
  const next = after < items.length && items[after].depth === depth ? after : -1;

  return { prev, next };
}

export function canMoveUp(items: { depth: number }[], index: number): boolean {
  return index > 0 && siblings(items, index).prev !== -1;
}

export function canMoveDown(items: { depth: number }[], index: number): boolean {
  return index >= 0 && index < items.length && siblings(items, index).next !== -1;
}

/**
 * The list's ids after moving a bullet past its sibling in `direction`,
 * carrying its own children with it — or null if there is no sibling that way.
 *
 * Returned as a whole id order rather than a pair of swaps because that is
 * what reorder_trip_notes takes: one atomic write, so a move can't half-apply
 * and leave client, server and realtime disagreeing about the order.
 */
export function moveSubtree<T extends { id: string; depth: number }>(
  items: T[], index: number, direction: 1 | -1,
): string[] | null {
  const { prev, next } = siblings(items, index);
  const start = index;
  const end = subtreeEnd(items, index);
  const moving = items.slice(start, end);
  const rest = [...items.slice(0, start), ...items.slice(end)];

  let insertAt: number;
  if (direction === -1) {
    if (prev === -1) return null;
    // Indices below the removed block are unaffected, so the previous
    // sibling's start is still where it was.
    insertAt = prev;
  } else {
    if (next === -1) return null;
    // The next sibling's whole subtree has to clear, and removing this block
    // first shifts it left by the block's own length.
    insertAt = subtreeEnd(items, next) - moving.length;
  }

  rest.splice(insertAt, 0, ...moving);
  return rest.map(i => i.id);
}

/** True when this bullet has anything nested under it — so it can be folded. */
export function hasChildren(items: { depth: number }[], index: number): boolean {
  return subtreeEnd(items, index) > index + 1;
}

/**
 * Drop every bullet that sits under a folded one.
 *
 * Walks once, carrying the depth of the shallowest fold currently in force:
 * everything deeper than that is hidden, and the first bullet back at or above
 * it ends the fold. That handles a folded section inside another folded
 * section without needing to know the tree.
 */
export function visibleItems<T extends { id: string; depth: number }>(
  items: T[], isCollapsed: (id: string) => boolean,
): T[] {
  const out: T[] = [];
  let hiddenBelow = -1;
  for (const item of items) {
    if (hiddenBelow >= 0 && item.depth > hiddenBelow) continue;
    hiddenBelow = -1;
    out.push(item);
    if (isCollapsed(item.id)) hiddenBelow = item.depth;
  }
  return out;
}

/**
 * Deleting a bullet promotes its children rather than taking them with it.
 *
 * Dynalist deletes the whole subtree, which is defensible when deletion is a
 * menu item you chose deliberately. Here it is also a left swipe, and a swipe
 * that can silently take five bullets with it is the kind of thing that loses
 * a day of planning. Promotion is visible and undoable by hand; a vanished
 * subtree is neither.
 */
export function promotionsAfterDelete(
  items: TripNote[], index: number,
): { id: string; depth: number }[] {
  const removed = items[index];
  if (!removed) return [];
  return subtree(items, index)
    .slice(1)
    .map(n => ({ id: n.id, depth: Math.max(0, n.depth - 1) }));
}

/**
 * The deepest a bullet may sit if it lands at `targetIndex`, given that its own
 * subtree has already been lifted out of the list.
 *
 * One level past the bullet above it, and no further — the same rule canIndent
 * enforces, expressed for a position rather than a move. At the very top there
 * is nothing above, so the only legal depth is 0.
 *
 * `rest` must be the list WITHOUT the block being dragged. Passing the full
 * list would measure the dragged bullet against itself as it slid past its own
 * old position, and the ceiling would jump around under the finger.
 */
export function maxDepthAt(rest: { depth: number }[], targetIndex: number): number {
  const above = rest[targetIndex - 1];
  if (!above) return 0;
  return Math.min(above.depth + 1, MAX_DEPTH);
}

/**
 * Move a subtree to an arbitrary position and depth — the drop half of a
 * Notion-style drag.
 *
 * moveSubtree above only steps one sibling at a time, which is all the arrow
 * buttons ever needed. A drag can land anywhere, so this takes a target index
 * and a target depth and returns the whole new order with the depths each
 * bullet should end up at.
 *
 * The depth is clamped rather than refused. A finger is not a precise
 * instrument, and the alternative — rejecting the drop because the thumb
 * drifted one level too deep — throws away a gesture the user clearly meant.
 * Descendants shift by whatever delta the root ended up with, so the subtree's
 * internal shape survives the move.
 *
 * Returns null when the move is a no-op, so callers can skip the write.
 */
export function dropSubtree<T extends { id: string; depth: number }>(
  items: T[], index: number, targetIndex: number, wantDepth: number,
): { id: string; depth: number }[] | null {
  if (index < 0 || index >= items.length) return null;
  const end = subtreeEnd(items, index);
  const moving = items.slice(index, end);
  const rest = [...items.slice(0, index), ...items.slice(end)];

  // targetIndex is expressed against `rest`, which is what the caller sees
  // while the block is out of the flow.
  const at = Math.max(0, Math.min(targetIndex, rest.length));
  const depth = Math.max(0, Math.min(wantDepth, maxDepthAt(rest, at)));
  const delta = depth - moving[0].depth;

  const landed = moving.map(n => ({ id: n.id, depth: Math.max(0, n.depth + delta) }));
  const next = [...rest.slice(0, at), ...landed, ...rest.slice(at)];

  const before = items.map(i => i.id + ':' + i.depth).join(',');
  const after = next.map(i => i.id + ':' + i.depth).join(',');
  if (before === after) return null;

  // normaliseDepths is the final word: clamping the root against its new
  // neighbour cannot know what the descendants' relative depths do further
  // down, and a subtree dragged from depth 3 to depth 0 can leave a gap.
  return normaliseDepths(next).map(i => ({ id: i.id, depth: i.depth }));
}

/**
 * Translate a drop expressed in VISIBLE rows into one expressed in the outline.
 *
 * The drag measures what is on screen, because that is what the finger is over.
 * The outline it edits includes bullets hidden under folds. The two lists stop
 * agreeing the moment anything is folded, so a target index cannot simply be
 * handed from one to the other.
 *
 * The bridge is an id, not a number: whichever visible row the block came to
 * rest above is looked up in the outline, and the block goes where that row is.
 * Landing "before the next visible row" is also what makes a folded bullet
 * behave — its children are off screen, so there is no way to express dropping
 * between them, which is the right answer rather than a missing feature.
 *
 * The bullet is named by id rather than by the index it had when the drag
 * started: a refetch mid-drag renumbers everything, and a stale index then
 * points at whichever bullet has since taken that slot.
 *
 * Returns indices for dropSubtree: `index` into `items`, `targetIndex` into
 * `items` with the moving block removed.
 */
export function structuralDrop(
  items: { id: string; depth: number }[],
  visible: { id: string }[],
  rootId: string,
  visibleTarget: number,
): { index: number; targetIndex: number } | null {
  const index = items.findIndex(n => n.id === rootId);
  if (index < 0) return null;

  const moving = new Set(items.slice(index, subtreeEnd(items, index)).map(n => n.id));
  const visibleRest = visible.filter(n => !moving.has(n.id));
  const itemsRest = items.filter(n => !moving.has(n.id));

  const anchorId = visibleRest[visibleTarget]?.id;
  if (anchorId === undefined) return { index, targetIndex: itemsRest.length };
  const targetIndex = itemsRest.findIndex(n => n.id === anchorId);
  return { index, targetIndex: targetIndex < 0 ? itemsRest.length : targetIndex };
}
