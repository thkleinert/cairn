import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { toast } from '../lib/toast';
import { updateTrip as updateTripRow, deleteTrip as deleteTripRow, TRIP_COLUMNS } from '../lib/trips';
import type { Trip } from '../types';

// A trip's sort key: its travel date, falling back to when it was created for
// trips with no dates yet. Both are ISO strings, so lexical compare orders
// them correctly (dates like '2026-10-23' sort against '2026-10-23T..' fine).
function tripSortKey(t: Trip): string {
  return t.start_date || t.created_at;
}

// Newest first.
function sortTrips(list: Trip[]): Trip[] {
  return [...list].sort((a, b) => tripSortKey(b).localeCompare(tripSortKey(a)));
}

export function useTrips(userId: string | undefined) {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTrips = useCallback(async () => {
    if (!userId) { setLoading(false); return; }
    // Embed a member count so the list can flag shared trips. Under the
    // trip_members RLS a member sees every member of their trips, so the count
    // is the true membership size.
    const { data, error } = await supabase
      .from('trips')
      .select(`${TRIP_COLUMNS}, trip_members(count)`);
    if (error) {
      toast('Could not load trips');
      setLoading(false);
      return;
    }
    type Row = Trip & { trip_members?: { count: number }[] };
    const withShared = ((data ?? []) as Row[]).map(({ trip_members = [], ...t }) => ({
      ...t,
      is_shared: (trip_members[0]?.count ?? 1) > 1,
    }));
    setTrips(sortTrips(withShared));
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    fetchTrips();
  }, [fetchTrips]);

  const createTrip = async (name: string, description?: string, start_date?: string, end_date?: string) => {
    if (!userId) return null;
    const { data, error } = await supabase.rpc('create_trip', {
      p_name: name,
      p_description: description ?? null,
      p_start_date: start_date ?? null,
      p_end_date: end_date ?? null,
    });
    if (error) throw error;
    // A brand-new trip has only its owner — not shared yet.
    if (data) setTrips(prev => sortTrips([{ ...data, is_shared: false }, ...prev]));
    return data;
  };

  // Mutations live in src/lib/trips.ts (TripView uses them without list
  // state); this wrapper just folds the result back into the sorted list.
  const updateTrip = async (id: string, updates: Partial<Trip>) => {
    const data = await updateTripRow(id, updates);
    if (!data) return null;
    // Preserve the derived is_shared flag (the update row doesn't carry it) and
    // re-sort in case the dates changed.
    setTrips(prev => sortTrips(prev.map(t => t.id === id ? { ...data, is_shared: t.is_shared } : t)));
    return data;
  };

  const deleteTrip = async (id: string) => {
    const ok = await deleteTripRow(id);
    if (ok) setTrips(prev => prev.filter(t => t.id !== id));
    return ok;
  };

  return { trips, loading, createTrip, updateTrip, deleteTrip };
}
