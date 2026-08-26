import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { toast } from '../lib/toast';
import { guardMessage } from '../lib/guards';
import { insertOnce } from '../lib/rows';
import type { PlaceVisit } from '../types';

// Every dated visit in a trip, in one subscription — the same shape
// useTripNotes has, and for the same reason: three surfaces ask about them
// (the outliner's timeline, the list view's date line, and the place sheet's
// editor) and a subscription each would be three answers to one question.
//
// Only `insertOnce` from lib/rows applies here. `restoreRow` and `applyOrder`
// both key off `position`, and a visit has none — its order is its start date,
// which is data rather than arrangement. There is nothing to drag, so there is
// nothing to renumber.

export function usePlaceVisits(tripId: string | undefined) {
  const [visits, setVisits] = useState<PlaceVisit[]>([]);
  const [loading, setLoading] = useState(true);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  // Realtime events arrive in bursts and each triggers a refetch; without this
  // the last response to *resolve* wins even when it carries an older snapshot.
  const fetchSeqRef = useRef(0);
  // The current visits, for reading AFTER an await — the same ref useTripNotes
  // keeps, for the same reason. A closure captures the list as it was when the
  // callback was made, which is a different list once a round trip has
  // happened. Concretely: the place sheet writes a departure onto a visit it
  // has only just inserted, and a captured array does not contain that row
  // yet, so the update found nothing and did nothing, silently.
  const visitsRef = useRef<PlaceVisit[]>([]);

  const fetchVisits = useCallback(async () => {
    if (!tripId) { setVisits([]); setLoading(false); return; }
    const seq = ++fetchSeqRef.current;
    const { data, error } = await supabase
      .from('place_visits')
      .select('*')
      .eq('trip_id', tripId)
      // Chronological, which is the order every surface wants. created_at
      // breaks ties for the same reason notes and places need a tiebreaker:
      // two visits can start on the same day, and tied rows would otherwise
      // come back in unspecified order and visibly swap between refetches.
      .order('starts_on', { ascending: true })
      .order('created_at', { ascending: true });

    if (seq !== fetchSeqRef.current) return;
    if (error) { toast('Could not load dates'); setLoading(false); return; }
    setVisits((data ?? []) as PlaceVisit[]);
    setLoading(false);
  }, [tripId]);

  useEffect(() => {
    if (!tripId) return;
    fetchVisits();
    channelRef.current = supabase
      .channel(`place_visits:${tripId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'place_visits',
        filter: `trip_id=eq.${tripId}`,
      }, () => { fetchVisits(); })
      .subscribe();
    return () => { channelRef.current?.unsubscribe(); };
  }, [tripId, fetchVisits]);

  visitsRef.current = visits;

  /**
   * Date a stop. `endsOn` null is a single day, not an open-ended stay.
   *
   * Returns the row, or null — the caller is adding a row to a list it is
   * rendering, and a failed insert has to leave that list alone rather than
   * show a visit the database does not have.
   *
   * Both guards the database can raise here say something worth reading
   * ("Only a stop can have dates"), so the message is passed through instead
   * of being replaced by a generic failure line. The client already refuses
   * the same things; this is what catches a collaborator changing a place out
   * from under the sheet.
   */
  const addVisit = useCallback(async (
    placeId: string,
    startsOn: string,
    endsOn: string | null = null,
  ): Promise<PlaceVisit | null> => {
    if (!tripId || !startsOn) return null;
    // Rejected by place_visits_dates_ordered anyway, but the constraint's own
    // message names a relation rather than explaining anything.
    if (endsOn && endsOn < startsOn) {
      toast('The departure cannot be before the arrival');
      return null;
    }

    const { data, error } = await supabase
      .from('place_visits')
      .insert({ trip_id: tripId, place_id: placeId, starts_on: startsOn, ends_on: endsOn })
      .select()
      .single();
    if (error || !data) {
      toast(guardMessage(error) ?? 'Could not save these dates');
      return null;
    }
    const created = data as PlaceVisit;
    setVisits(prev => insertOnce(prev, created));
    // The ref too, not just the state. A caller that follows this with an
    // update to the row it just got back — the sheet applying a departure
    // picked while the insert was in flight — runs before React has
    // re-rendered, and updateVisit would not find it.
    visitsRef.current = insertOnce(visitsRef.current, created);
    return created;
  }, [tripId]);

  /**
   * Move one end of a visit, or both.
   *
   * Optimistic, and on failure it refetches rather than reverting to a
   * call-time snapshot — the same rule updateNote follows, so a collaborator's
   * concurrent edit is not clobbered by our idea of what the row used to say.
   */
  const updateVisit = useCallback(async (
    id: string,
    updates: { starts_on?: string; ends_on?: string | null },
  ): Promise<boolean> => {
    const current = visitsRef.current.find(v => v.id === id);
    if (!current) return false;
    const next = { ...current, ...updates };
    if (next.ends_on && next.ends_on < next.starts_on) {
      toast('The departure cannot be before the arrival');
      return false;
    }

    // The ref alongside the state, exactly as addVisit does it. Two edits to
    // one visit issued before React re-renders — moving the arrival, then
    // adjusting the departure, which is what two adjacent date fields invite —
    // would otherwise have the second read a pre-first-edit `current` above.
    // Its ordering check then passes on stale values, Postgres refuses the
    // write against the real row, and because that constraint's message is the
    // generated form guardMessage rightly suppresses, the user gets the
    // generic line and a refetch that reverts what they just did.
    const apply = (rows: PlaceVisit[]) =>
      rows.map(v => v.id === id ? { ...v, ...updates } : v);
    visitsRef.current = apply(visitsRef.current);
    setVisits(apply);

    const { data, error } = await supabase
      .from('place_visits')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error || !data) {
      toast(guardMessage(error) ?? 'Could not save these dates');
      fetchVisits();
      return false;
    }
    const merge = (rows: PlaceVisit[]) =>
      rows.map(v => v.id === id ? { ...v, ...(data as PlaceVisit) } : v);
    visitsRef.current = merge(visitsRef.current);
    setVisits(merge);
    return true;
  }, [fetchVisits]);

  /**
   * Undate a visit.
   *
   * Snapshot-and-restore rather than refetch, for the reason removeNote does
   * it: on a failed delete the row is still there, so the user should see it
   * come back immediately rather than watch a gap for a round trip.
   */
  const removeVisit = useCallback(async (id: string): Promise<boolean> => {
    const previous = visitsRef.current;
    visitsRef.current = previous.filter(v => v.id !== id);
    setVisits(prev => prev.filter(v => v.id !== id));
    const { error } = await supabase.from('place_visits').delete().eq('id', id);
    if (error) {
      toast('Could not remove these dates');
      visitsRef.current = previous;
      setVisits(previous);
      return false;
    }
    return true;
  }, []);

  return { visits, loading, addVisit, updateVisit, removeVisit };
}
