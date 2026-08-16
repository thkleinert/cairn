import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { toast } from '../lib/toast';
import type { TripNote } from '../types';

// Every bullet for a trip, both the trip-wide ones (place_id null) and the
// per-place ones, in a single subscription. They live in one table and one
// realtime channel because they're the same kind of thing at different scopes,
// and a place's bullets are needed by the trip-wide notes page anyway.

export function useTripNotes(tripId: string | undefined) {
  const [notes, setNotes] = useState<TripNote[]>([]);
  const [loading, setLoading] = useState(true);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  // Realtime events arrive in bursts and each triggers a refetch; without this
  // the last response to *resolve* wins even when it carries an older snapshot.
  const fetchSeqRef = useRef(0);

  const fetchNotes = useCallback(async () => {
    if (!tripId) { setLoading(false); return; }
    const seq = ++fetchSeqRef.current;
    const { data, error } = await supabase
      .from('trip_notes')
      .select('*')
      .eq('trip_id', tripId)
      // created_at tiebreaker for the same reason places needs one: positions
      // can collide (deletes never compact them) and tied rows would otherwise
      // come back in unspecified order and visibly swap between refetches.
      .order('position', { ascending: true })
      .order('created_at', { ascending: true });

    if (seq !== fetchSeqRef.current) return;
    if (error) { toast('Could not load notes'); setLoading(false); return; }
    setNotes((data ?? []) as TripNote[]);
    setLoading(false);
  }, [tripId]);

  useEffect(() => {
    if (!tripId) return;
    fetchNotes();
    channelRef.current = supabase
      .channel(`trip_notes:${tripId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'trip_notes',
        filter: `trip_id=eq.${tripId}`,
      }, () => { fetchNotes(); })
      .subscribe();
    return () => { channelRef.current?.unsubscribe(); };
  }, [tripId, fetchNotes]);

  const tripNotes = useMemo(
    () => notes.filter(n => !n.place_id),
    [notes]
  );

  const notesByPlace = useMemo(() => {
    const map = new Map<string, TripNote[]>();
    for (const n of notes) {
      if (!n.place_id) continue;
      const list = map.get(n.place_id);
      if (list) list.push(n); else map.set(n.place_id, [n]);
    }
    return map;
  }, [notes]);

  const addNote = useCallback(async (body: string, placeId?: string | null) => {
    const trimmed = body.trim();
    // The DB rejects a blank body outright; don't bother the network with it.
    if (!tripId || !trimmed) return null;
    // max+1 within this scope, not length: deletes leave gaps, and length
    // would collide with an existing position.
    const scope = notes.filter(n => (n.place_id ?? null) === (placeId ?? null));
    const position = scope.reduce((max, n) => Math.max(max, n.position), -1) + 1;
    const { data: auth } = await supabase.auth.getUser();

    const { data, error } = await supabase
      .from('trip_notes')
      .insert({
        trip_id: tripId,
        place_id: placeId ?? null,
        body: trimmed,
        position,
        created_by: auth.user?.id ?? null,
      })
      .select()
      .single();
    if (error || !data) { toast('Could not add note'); return null; }
    setNotes(prev => [...prev, data as TripNote]);
    return data as TripNote;
  }, [tripId, notes]);

  const removeNote = useCallback(async (id: string) => {
    // Snapshot for rollback: a delete is the one operation where refetching on
    // failure isn't enough — the row is still there, so the user needs to see
    // it come back rather than wait for a round trip.
    const previous = notes;
    setNotes(prev => prev.filter(n => n.id !== id));
    const { error } = await supabase.from('trip_notes').delete().eq('id', id);
    if (error) {
      toast('Could not delete note');
      setNotes(previous);
    }
    return null;
  }, [notes]);

  const updateNote = useCallback(async (id: string, body: string) => {
    const trimmed = body.trim();
    // An emptied bullet is a delete — the check constraint would reject a blank
    // body anyway, and leaving an empty row on screen is worse than removing it.
    if (!trimmed) return removeNote(id);

    // Optimistic; on failure refetch rather than revert, so a collaborator's
    // concurrent edit isn't clobbered by a stale call-time snapshot.
    setNotes(prev => prev.map(n => n.id === id ? { ...n, body: trimmed } : n));
    const { data, error } = await supabase
      .from('trip_notes')
      .update({ body: trimmed })
      .eq('id', id)
      .select()
      .single();
    if (error || !data) { toast('Could not save note'); fetchNotes(); return null; }
    setNotes(prev => prev.map(n => n.id === id ? { ...n, ...(data as TripNote) } : n));
    return data as TripNote;
  }, [fetchNotes, removeNote]);

  const reorderNotes = useCallback(async (orderedIds: string[]) => {
    if (!tripId) return;
    // Apply immediately, then write the whole order atomically — per-row
    // updates could partially fail and leave three different orders around.
    setNotes(prev => {
      const rank = new Map(orderedIds.map((id, i) => [id, i]));
      return prev.map(n => rank.has(n.id) ? { ...n, position: rank.get(n.id)! } : n)
        .sort((a, b) => a.position - b.position ||
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    });
    const { error } = await supabase.rpc('reorder_trip_notes', {
      p_trip_id: tripId,
      p_note_ids: orderedIds,
    });
    if (error) { toast('Could not save the new order'); fetchNotes(); }
  }, [tripId, fetchNotes]);

  return { tripNotes, notesByPlace, loading, addNote, updateNote, removeNote, reorderNotes };
}
