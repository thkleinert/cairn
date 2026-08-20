import { usePersistentSet } from './usePersistentSet';

// Which sections of a trip's outline are folded shut, remembered per trip.
//
// Note ids and place ids are both uuids from the same generator, so one set
// holds both without a prefix and without any chance of collision. The
// trip-wide section uses a constant key, which cannot collide with a uuid.
export function useCollapsed(tripId: string | undefined) {
  const { has, toggle, remove } = usePersistentSet(tripId ? `cairn:collapsed:${tripId}` : null);
  return { isCollapsed: has, toggle, expand: remove };
}
