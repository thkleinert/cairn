import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { Trip } from '../types';

export function useTrips(userId: string | undefined) {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTrips = useCallback(async () => {
    if (!userId) { setLoading(false); return; }
    const { data } = await supabase
      .from('trips')
      .select('*')
      .order('created_at', { ascending: false });
    setTrips(data ?? []);
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
    if (data) setTrips(prev => [data, ...prev]);
    return data;
  };

  const updateTrip = async (id: string, updates: Partial<Trip>) => {
    const { data, error } = await supabase
      .from('trips')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (!error && data) setTrips(prev => prev.map(t => t.id === id ? data : t));
    return data;
  };

  const deleteTrip = async (id: string) => {
    await supabase.from('trips').delete().eq('id', id);
    setTrips(prev => prev.filter(t => t.id !== id));
  };

  return { trips, loading, createTrip, updateTrip, deleteTrip, refetch: fetchTrips };
}
