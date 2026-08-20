import { useCallback } from 'react';
import { usePersistentSet } from './usePersistentSet';

// Which sections of a trip are folded shut, per view.
//
// Both views fold, and both remember it, but they want opposite defaults: the
// places list is an overview and reads better shut, while the notes page is
// where you read what is written and would be pointless shut. That was two
// hooks with two storage keys and two opposite meanings for "present in the
// set", which is a subtlety waiting to be got wrong.
//
// One hook now, and the default is a parameter rather than an inversion buried
// in a caller. The set stores whatever the ODD case is — folded ids when the
// default is open, opened ids when the default is folded — so "nothing
// recorded" always means "the default", and neither caller has to know which
// way round the storage runs.
//
// Kept per scope rather than shared: folding a section is not a statement
// about wanting the bullets inside it folded too.
//
// localStorage rather than the database, because this is how *you* are looking
// at a trip right now. Stored server-side it would fold a collaborator's
// sections shut while they were reading them.

export type FoldScope =
  /** Sections on the outliner: General, and one per place. Folded by default. */
  | 'notes'
  /** Bullets within those sections. Open by default — you opened the section
   *  to read them, and a bullet is not a section. */
  | 'bullets'
  /** Rows on the places list. Folded by default. */
  | 'list';

interface Options {
  /** What a section with nothing recorded about it does. */
  defaultFolded: boolean;
}

export function useFoldState(
  tripId: string | undefined,
  scope: FoldScope,
  { defaultFolded }: Options,
) {
  const { has, toggle, add, remove } = usePersistentSet(
    tripId ? `cairn:fold:${scope}:${tripId}` : null,
  );

  // Present in the set means "not the default", whichever the default is.
  const isFolded = useCallback(
    (id: string) => (defaultFolded ? !has(id) : has(id)),
    [has, defaultFolded],
  );

  /** Force a section open — used when something has to be visible to act on. */
  const expand = useCallback(
    (id: string) => { if (defaultFolded) add(id); else remove(id); },
    [add, remove, defaultFolded],
  );

  return { isFolded, toggle, expand };
}
