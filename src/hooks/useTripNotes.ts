import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { toast } from '../lib/toast';
import { insertOnce, restoreRow, applyOrder } from '../lib/rows';
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
  // addNote reorders after a mid-list insert, but reorderNotes is defined
  // below it. A ref breaks that cycle without reshuffling the file into
  // dependency order.
  const reorderRef = useRef<((ids: string[]) => Promise<boolean>) | null>(null);
  // The current notes, for reading AFTER an await. A closure captures them as
  // they were when the callback was made, which is a different list once a
  // round trip has happened.
  const notesRef = useRef<TripNote[]>([]);

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

  notesRef.current = notes;

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

  /**
   * Append a bullet, or slot one in directly after `afterId`.
   *
   * The insert always lands at the end of its scope and the caller's intended
   * order is applied afterwards by reorder_trip_notes. Two round trips, but
   * the alternative — renumbering the rows below to open a gap — is several
   * writes that can partially fail, and the RPC already does exactly this
   * atomically. Enter-in-the-middle-of-a-list is not a hot path.
   */
  const addNote = useCallback(async (
    body: string,
    placeId?: string | null,
    opts?: { depth?: number; afterId?: string | null },
  ) => {
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
        depth: opts?.depth ?? 0,
        created_by: auth.user?.id ?? null,
      })
      .select()
      .single();
    if (error || !data) { toast('Could not add note'); return null; }
    const created = data as TripNote;
    setNotes(prev => insertOnce(prev, created));

    // Only when it isn't already where it belongs — appending after the last
    // bullet, which is the common case, needs no reorder at all.
    const afterId = opts?.afterId;
    if (afterId && scope.length > 0 && scope[scope.length - 1].id !== afterId) {
      // Rebuilt from current state, not from the `scope` captured before the
      // insert. reorder_trip_notes renumbers only the ids it is handed, so a
      // bullet that arrived during the round trip — a collaborator's, or one
      // the insert's own realtime refetch delivered — would be left out and
      // keep a position every other row in the scope had just been renumbered
      // past, colliding with one of them.
      const current = notesRef.current
        .filter(n => (n.place_id ?? null) === (placeId ?? null))
        .sort((a, b) => a.position - b.position ||
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      const ordered = current.map(n => n.id).filter(id => id !== created.id);
      const at = ordered.indexOf(afterId);
      if (at !== -1) {
        ordered.splice(at + 1, 0, created.id);
        await reorderRef.current?.(ordered);
      }
    }
    return created;
  }, [tripId, notes]);

  /**
   * Re-nest a bullet and everything under it.
   *
   * `ids` is the bullet plus its descendants — the caller works those out from
   * the rendered outline, since with a flat depth list "descendants" means the
   * run of following bullets that are deeper, and only the view knows the run.
   * Written as one update per level rather than per row: every id moving by
   * the same delta shares a target depth, so this is at most a couple of
   * statements no matter how large the subtree.
   */
  const setNoteDepths = useCallback(async (updates: { id: string; depth: number }[]) => {
    if (!tripId || updates.length === 0) return;
    const next = new Map(updates.map(u => [u.id, u.depth]));

    // Snapshotted from a plain read, BEFORE the state update. Collecting it
    // inside the updater looked equivalent but is not: React may invoke an
    // updater more than once (StrictMode does, and so does concurrent
    // rebasing), and a second run against already-updated state records the
    // new depth as the thing to roll back to — a rollback that restores
    // exactly what it was meant to undo.
    const previousDepths = notes
      .filter(n => next.has(n.id))
      .map(n => ({ id: n.id, depth: n.depth }));

    setNotes(prev => prev.map(n => next.has(n.id) ? { ...n, depth: next.get(n.id)! } : n));

    // One statement, through an RPC, for the reason reorder_trip_notes is one:
    // this used to be an UPDATE per distinct depth, and a failure on the
    // second left the first committed — whose realtime event then overwrote
    // the client's rollback with the half-applied shape.
    const { error } = await supabase.rpc('set_trip_note_depths', {
      p_trip_id: tripId,
      p_note_ids: updates.map(u => u.id),
      p_depths: updates.map(u => u.depth),
    });
    if (error) {
      toast('Could not change the indent');
      const back = new Map(previousDepths.map(r => [r.id, r.depth]));
      setNotes(prev => prev.map(n => back.has(n.id) ? { ...n, depth: back.get(n.id)! } : n));
    }
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
      return false;
    }
    return true;
  }, [notes]);

  /**
   * Put a deleted bullet back exactly where it was — the Undo behind a swipe.
   *
   * Re-inserted with its original id, position and depth rather than appended,
   * so undo restores the outline rather than dumping the bullet at the bottom
   * at the outer level. Nothing references a note's id, so reusing it is safe.
   */
  const restoreNote = useCallback(async (note: TripNote) => {
    setNotes(prev => restoreRow(prev, note));

    const { data: auth } = await supabase.auth.getUser();
    const { error } = await supabase.from('trip_notes').insert({
      id: note.id,
      trip_id: note.trip_id,
      place_id: note.place_id ?? null,
      body: note.body,
      position: note.position,
      depth: note.depth,
      // The insert policy requires created_by to be the caller or null, so a
      // collaborator's note comes back authorless rather than not at all.
      // Losing the byline is a smaller loss than losing the note.
      created_by: note.created_by === auth.user?.id ? note.created_by : null,
    });
    if (error) { toast('Could not restore the note'); fetchNotes(); return false; }
    return true;
  }, [fetchNotes]);

  const updateNote = useCallback(async (id: string, body: string) => {
    const trimmed = body.trim();
    // An emptied bullet is a delete — the check constraint would reject a blank
    // body anyway, and leaving an empty row on screen is worse than removing it.
    if (!trimmed) { await removeNote(id); return null; }

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

  const reorderNotes = useCallback(async (orderedIds: string[]): Promise<boolean> => {
    if (!tripId) return false;
    // Apply immediately, then write the whole order atomically — per-row
    // updates could partially fail and leave three different orders around.
    setNotes(prev => applyOrder(prev, orderedIds));
    const { error } = await supabase.rpc('reorder_trip_notes', {
      p_trip_id: tripId,
      p_note_ids: orderedIds,
    });
    // Reported, not just toasted: a caller that follows this with a second
    // structural write — the bullet drag writes order then depth — has to be
    // able to stop. Writing the new depths against the old order leaves a
    // bullet stored as a child of whatever happens to precede it.
    if (error) { toast('Could not save the new order'); fetchNotes(); return false; }
    return true;
  }, [tripId, fetchNotes]);

  reorderRef.current = reorderNotes;

  return {
    tripNotes, notesByPlace, loading,
    addNote, updateNote, removeNote, restoreNote, reorderNotes, setNoteDepths,
  };
}
