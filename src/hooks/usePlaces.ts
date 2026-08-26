import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { toast } from '../lib/toast';
import { insertOnce, applyOrder } from '../lib/rows';
import { guardMessage } from '../lib/guards';
import { isEphemeralGoogleUrl, fetchFreshGooglePhotoUrl, persistGooglePhoto } from '../lib/googlePhotos';
import { kindFor } from '../lib/anchor';
import { removeStorageUrls } from '../lib/storage';
import type { Place, PlaceImage } from '../types';

export function usePlaces(tripId: string | undefined) {
  const [places, setPlaces] = useState<Place[]>([]);
  const [loading, setLoading] = useState(true);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const healingRef = useRef<Set<string>>(new Set());
  // Realtime events arrive in bursts and each one triggers a refetch; without
  // a sequence guard the *last response to resolve* would win, even if it
  // carries an older DB snapshot than one that already rendered.
  const fetchSeqRef = useRef(0);
  // Current place ids, for deciding whether a join-table event is ours (those
  // tables carry no trip_id to filter on server-side).
  const placeIdsRef = useRef<Set<string>>(new Set());

  // Self-heal: a cover photo still pointing at Google's ephemeral session
  // URL has already expired (that URL's bytes can't be fetched anymore),
  // so re-resolve a fresh one via the place's google_place_id and persist
  // it to our own storage this time. One attempt per place per session.
  const selfHealCoverPhoto = useCallback(async (place: Place) => {
    if (!isEphemeralGoogleUrl(place.image_url) || !place.google_place_id) return;
    if (healingRef.current.has(place.id)) return;
    healingRef.current.add(place.id);

    const freshUrl = await fetchFreshGooglePhotoUrl(place.google_place_id);
    if (!freshUrl) return;
    const stableUrl = await persistGooglePhoto(place.trip_id, place.id, freshUrl);
    if (!stableUrl) return;

    const { data, error } = await supabase
      .from('places')
      .update({ image_url: stableUrl })
      .eq('id', place.id)
      .select()
      .single();
    if (!error && data) {
      setPlaces(prev => prev.map(p => p.id === place.id ? { ...p, image_url: data.image_url } : p));
    }
  }, []);

  const fetchPlaces = useCallback(async () => {
    if (!tripId) { setLoading(false); return; }
    const seq = ++fetchSeqRef.current;
    const { data, error } = await supabase
      .from('places')
      .select('*, place_tags(tag_id, tags(*)), place_images(*)')
      .eq('trip_id', tripId)
      // created_at tiebreaker: positions can collide (deletes never compact
      // them), and without it tied rows come back in unspecified order and
      // visibly swap between refetches.
      .order('position', { ascending: true })
      .order('created_at', { ascending: true });

    // A newer fetch was issued while this one was in flight — its response
    // supersedes this one no matter which resolves first.
    if (seq !== fetchSeqRef.current) return;

    if (error) {
      toast('Could not load places');
      setLoading(false);
      return;
    }

    const normalized = (data ?? []).map((p: Place & { place_tags?: Array<{ tags: unknown }>, place_images?: PlaceImage[] }) => ({
      ...p,
      tags: (p.place_tags ?? []).map((pt) => pt.tags),
      images: (p.place_images ?? []).sort((a, b) => a.position - b.position),
    }));
    placeIdsRef.current = new Set(normalized.map(p => p.id));
    setPlaces(normalized as Place[]);
    setLoading(false);
    (normalized as Place[]).forEach(p => { selfHealCoverPhoto(p); });
  }, [tripId, selfHealCoverPhoto]);

  useEffect(() => {
    if (!tripId) return;
    fetchPlaces();

    // place_tags/place_images have no trip_id column, so those events can't
    // be filtered server-side — check the payload's place_id against ours.
    // (Without these subscriptions, a collaborator's tag/photo edits never
    // showed up until some unrelated places-row change forced a refetch.)
    const onJoinTableChange = (payload: { new: unknown; old: unknown }) => {
      const rec = (payload.new ?? payload.old) as { place_id?: string } | null;
      if (rec?.place_id && placeIdsRef.current.has(rec.place_id)) fetchPlaces();
    };

    channelRef.current = supabase
      .channel(`places:${tripId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'places',
        filter: `trip_id=eq.${tripId}`,
      }, () => { fetchPlaces(); })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'place_tags',
      }, onJoinTableChange)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'place_images',
      }, onJoinTableChange)
      .subscribe();

    return () => {
      channelRef.current?.unsubscribe();
    };
  }, [tripId, fetchPlaces]);

  const addPlace = async (place: {
    name: string;
    address?: string;
    latitude: number;
    longitude: number;
    google_place_id?: string;
    image_url?: string;
    notes?: string;
    /**
     * Google's own classification, when the caller has it. A hint for kindFor
     * only — there is no such column, so it is destructured out below rather
     * than spread into the insert, which would fail the whole write.
     */
    types?: string[];
    /** Same: a hint for kindFor, not a column. */
    spanKm?: number;
  }) => {
    if (!tripId) return null;
    // max+1, not length: after any delete the positions have gaps, and
    // length would collide with an existing position.
    const nextPosition = places.reduce((max, p) => Math.max(max, p.position), -1) + 1;

    // Decide what this place is, and what it sits inside, from the trip it is
    // joining. Done here, in the insert, rather than as a follow-up write: it
    // costs nothing extra and the place is never briefly misfiled.
    //
    // Only on creation. There is nothing to disturb at this moment and both
    // can be changed on the place sheet, whereas silently re-filing a place
    // someone already put somewhere is not ours to do — existing places get an
    // offer on the notes page instead.
    const { kind, parentId } = kindFor(place, places);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { types, spanKm, ...row } = place;

    const { data, error } = await supabase
      .from('places')
      .insert({
        ...row,
        trip_id: tripId,
        position: nextPosition,
        kind,
        parent_place_id: parentId,
      })
      .select()
      .single();
    if (error || !data) {
      toast('Could not add place');
      return null;
    }
    placeIdsRef.current.add(data.id);
    setPlaces(prev => insertOnce(prev, { ...data, tags: [], images: [] }));

    // The image_url passed in (if any) is a fresh but still-ephemeral
    // Google session URL — persist it to our own storage right away so
    // it doesn't just expire like the ones added before this existed.
    // Mark it as healing first: the insert's own realtime event triggers a
    // refetch whose self-heal pass would otherwise race this persist and
    // upload the photo a second time.
    if (data.image_url) {
      healingRef.current.add(data.id);
      persistGooglePhoto(tripId, data.id, data.image_url).then(async stableUrl => {
        if (!stableUrl) return;
        const { data: updated, error: updateError } = await supabase
          .from('places')
          .update({ image_url: stableUrl })
          .eq('id', data.id)
          .select()
          .single();
        if (!updateError && updated) {
          setPlaces(prev => prev.map(p => p.id === data.id ? { ...p, image_url: updated.image_url } : p));
        }
      });
    }

    return data;
  };

  const updatePlace = async (id: string, updates: Partial<Place>) => {
    // Optimistic: apply immediately; on failure refetch rather than revert —
    // a call-time snapshot could clobber fresher data a collaborator's edit
    // delivered while our write was in flight.
    setPlaces(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p));

    const { data, error } = await supabase
      .from('places')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error || !data) {
      // A guard that refused this has already said why, in words meant for
      // the person reading them — "Remove this place's dates before making it
      // a spot" names the control that fixes it, where "Could not save
      // changes" leaves someone with no idea what to try next. Anything the
      // database did not phrase for a reader keeps the generic line.
      toast(guardMessage(error) ?? 'Could not save changes');
      fetchPlaces();
      return null;
    }
    setPlaces(prev => prev.map(p => p.id === id ? { ...p, ...data } : p));
    return data;
  };

  const deletePlace = async (id: string) => {
    const place = places.find(p => p.id === id);


    const { error } = await supabase.from('places').delete().eq('id', id);
    if (error) {
      toast('Could not delete place');
      return;
    }
    placeIdsRef.current.delete(id);
    setPlaces(prev => prev.filter(p => p.id !== id));

    // Only now, and only because the delete succeeded. The composite FK is
    // `on delete set null (parent_place_id)`, so the database has already
    // released whatever was inside — but it cannot touch `kind`, and a
    // spot belonging to nothing is a state the rest of the app has to keep
    // special-casing.
    //
    // Written as a condition rather than a list of ids. The list was read from
    // this client's snapshot BEFORE the delete, which made it wrong in both
    // directions: a café a collaborator had already moved into another stop was
    // still in the list and got yanked out of it by a delete that had nothing
    // to do with it, and a café moved IN while the delete was in flight was
    // missing from the list and stayed orphaned. A statement that names the
    // condition instead of the rows cannot be stale, and repairs any orphan
    // left by an earlier failure at the same time.
    setPlaces(prev => prev.map(p => p.parent_place_id === id
      ? { ...p, parent_place_id: null, kind: 'stop' as const } : p));
    const { error: releaseError } = await supabase
      .from('places')
      .update({ kind: 'stop' })
      .eq('trip_id', tripId)
      .eq('kind', 'spot')
      .is('parent_place_id', null);
    // Not fatal: the places are already top-level and visible in the list.
    // Only the map filter would still hide them, and a refetch will show
    // whatever the database really holds.
    if (releaseError) fetchPlaces();

    // The bucket is public — remove the actual files, not just the rows.
    if (place) {
      removeStorageUrls([place.image_url, ...(place.images ?? []).map(i => i.url)]);
    }
  };

  // Drag-to-reorder: apply the new order immediately; the whole order is
  // written atomically by an RPC (per-row updates could partially fail,
  // leaving server, client, and realtime with three different orders).
  const reorderPlaces = async (orderedIds: string[]) => {
    if (!tripId) return;
    setPlaces(prev => applyOrder(prev, orderedIds));

    const { error } = await supabase.rpc('reorder_places', {
      p_trip_id: tripId,
      p_place_ids: orderedIds,
    });
    if (error) {
      toast('Could not save the new order');
      fetchPlaces();
    }
  };

  const toggleVisited = async (id: string, currentStatus: string) => {
    const newStatus = currentStatus === 'planned' ? 'visited' : 'planned';
    const updates: Partial<Place> = {
      status: newStatus as Place['status'],
      visited_at: newStatus === 'visited' ? new Date().toISOString() : null,
    };
    return updatePlace(id, updates);
  };

  const setPlaceTags = async (placeId: string, tagIds: string[]) => {
    // Diff against current tags — avoids the destructive delete-all-then-insert
    const current = (places.find(p => p.id === placeId)?.tags ?? []).map(t => t.id);
    const toRemove = current.filter(id => !tagIds.includes(id));
    const toAdd = tagIds.filter(id => !current.includes(id));

    if (toRemove.length > 0) {
      const { error } = await supabase
        .from('place_tags')
        .delete()
        .eq('place_id', placeId)
        .in('tag_id', toRemove);
      // Refetch even on failure: the delete may have half-applied relative to
      // what the user saw, and nothing else re-syncs this session.
      if (error) { toast('Could not update tags'); fetchPlaces(); return; }
    }
    if (toAdd.length > 0) {
      const { error } = await supabase
        .from('place_tags')
        .insert(toAdd.map(tag_id => ({ place_id: placeId, tag_id })));
      if (error) { toast('Could not update tags'); fetchPlaces(); return; }
    }
    fetchPlaces();
  };

  const addPlaceImage = async (placeId: string, url: string, caption?: string) => {
    const existing = places.find(p => p.id === placeId);
    const position = (existing?.images?.length ?? 0);
    const { data, error } = await supabase
      .from('place_images')
      .insert({ place_id: placeId, url, caption: caption || null, position })
      .select()
      .single();
    if (error || !data) {
      toast('Could not add photo');
      return null;
    }
    setPlaces(prev => prev.map(p =>
      p.id === placeId ? { ...p, images: [...(p.images ?? []), data] } : p
    ));
    return data as PlaceImage;
  };

  // Uploads to the place-images bucket under {trip_id}/{place_id}/... — the
  // storage RLS policy checks trip membership from that first path segment
  const uploadPlaceImage = async (placeId: string, file: File) => {
    const place = places.find(p => p.id === placeId);
    if (!place) return null;
    const ext = file.name.split('.').pop() || 'jpg';
    const path = `${place.trip_id}/${placeId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('place-images')
      .upload(path, file, { contentType: file.type || 'image/jpeg' });
    if (uploadError) {
      toast('Could not upload photo');
      return null;
    }

    const { data } = supabase.storage.from('place-images').getPublicUrl(path);
    return addPlaceImage(placeId, data.publicUrl);
  };

  const removePlaceImage = async (placeId: string, imageId: string) => {
    const image = places.find(p => p.id === placeId)?.images?.find(i => i.id === imageId);
    const { error } = await supabase.from('place_images').delete().eq('id', imageId);
    if (error) {
      toast('Could not remove photo');
      return;
    }
    setPlaces(prev => prev.map(p =>
      p.id === placeId ? { ...p, images: (p.images ?? []).filter(i => i.id !== imageId) } : p
    ));
    // The bucket is public — a "removed" photo must stop being fetchable.
    if (image) removeStorageUrls([image.url]);
  };

  /**
   * Anchor a place inside another, or release it with null.
   *
   * Its own function rather than a general updatePlace call for the reason the
   * others are: the caller says what it means, and the set of columns anything
   * outside this hook can write stays enumerable. Cycles are refused here as
   * well as one level down — the database can only stop a place being its own
   * parent, so a→b→a is caught by the one check that can see both ends.
   */
  const setPlaceParent = async (id: string, parentId: string | null) => {
    if (parentId === id) return null;
    const parent = parentId ? places.find(p => p.id === parentId) : null;
    if (parent?.parent_place_id === id) {
      toast('Those two places would be inside each other');
      return null;
    }
    // Refused rather than cascaded. Only a stop can hold spots, so filing a
    // place inside another makes it a spot and everything anchored to it
    // instantly has a parent that cannot be one — groupPlaces stops nesting
    // them and they pop to the top level, still marked as spots, so the
    // map's Spots toggle hides rows that now look like ordinary stops.
    // The database cannot catch it: places_anchored_is_spot only inspects
    // the row being written.
    //
    // Moving the children too would be a second, invisible decision about
    // somebody else's data, so this asks instead.
    if (parentId && places.some(p => p.parent_place_id === id)) {
      toast('Move the places inside it out first');
      return null;
    }
    // Kind moves with the parent, because the two are one decision: being
    // inside a stop is what makes something a spot, and the database
    // refuses anything anchored that is not one. Setting them separately would
    // mean a moment where the row cannot be written at all.
    return updatePlace(id, {
      parent_place_id: parentId,
      kind: parentId ? 'spot' : 'stop',
    });
  };

  // updatePlace is deliberately not exported: since sources folded into notes
  // nothing outside this hook writes an arbitrary column on a place, and every
  // edit that remains has its own narrower function above. It stays as the
  // shared implementation those are built on.
  return { places, loading, addPlace, deletePlace, toggleVisited, setPlaceTags, setPlaceParent, addPlaceImage, uploadPlaceImage, removePlaceImage, reorderPlaces };
}
