// Optimistic edits to a list of rows held in React state.
//
// Both hooks that own such a list — places and trip notes — insert after a
// create and renumber after a reorder, against the same realtime subscription
// and the same refetch. They had written that twice and drifted: the notes
// insert guarded against the refetch beating it and the places insert did not,
// and the places reorder rebuilt every row from a stale closure while the
// notes reorder only touched positions. One of those was a duplicated bullet;
// the other silently undid a change made in the same tick and dropped every
// row it had not been handed.
//
// Neither was a hard problem. They were two implementations of one idea, and
// only one of them got fixed each time.

/** Newest-last ordering: by position, then creation time to break ties. */
function byPositionThenAge<T extends { position: number; created_at: string }>(a: T, b: T): number {
  return a.position - b.position ||
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}

/**
 * Add a freshly inserted row, unless it is already there.
 *
 * An insert fires its own realtime event, and the refetch that event triggers
 * carries the new row. Whichever resolves first, the row appears exactly once:
 * appending unconditionally puts the same id in the array twice, and the list
 * renders it twice until something else forces a refetch.
 */
export function insertOnce<T extends { id: string }>(rows: T[], row: T): T[] {
  return rows.some(r => r.id === row.id) ? rows : [...rows, row];
}

/**
 * Put a row back where it was — the undo behind a delete.
 *
 * Same guard as insertOnce, plus a re-sort, because a restored row belongs at
 * its old position rather than at the end.
 */
export function restoreRow<T extends { id: string; position: number; created_at: string }>(
  rows: T[], row: T,
): T[] {
  return rows.some(r => r.id === row.id) ? rows : [...rows, row].sort(byPositionThenAge);
}

/**
 * Renumber the given ids to match their order, and leave every other row
 * exactly as it is.
 *
 * Two properties matter, and both were once absent from the places version:
 *
 *   - rows not named in `orderedIds` are KEPT, so a view that reorders only
 *     part of a list leaves the rest untouched rather than dropping it until
 *     the next refetch.
 *   - only `position` is written. Rebuilding each row from a captured array
 *     writes back a stale copy of every other field, silently undoing anything
 *     changed in the same tick.
 */
export function applyOrder<T extends { id: string; position: number; created_at: string }>(
  rows: T[], orderedIds: string[],
): T[] {
  const rank = new Map(orderedIds.map((id, index) => [id, index]));
  return rows
    .map(row => rank.has(row.id) ? { ...row, position: rank.get(row.id)! } : row)
    .sort(byPositionThenAge);
}
