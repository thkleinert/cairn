import { useEffect, useState } from 'react';
import { MapPin, Lock } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { Trip, Place, Tag } from '../types';
import { MapView } from './MapView';
import { PlaceDetailSheet } from './PlaceDetailSheet';

interface Props {
  shareToken: string;
}

export function SharedTripView({ shareToken }: Props) {
  const [trip, setTrip] = useState<Trip | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      const { data: tripData } = await supabase
        .from('trips')
        .select('*')
        .eq('share_token', shareToken)
        .single();

      if (!tripData) { setError('Trip not found or link is invalid.'); return; }
      setTrip(tripData);

      const { data: placesData } = await supabase
        .from('places')
        .select('*, place_tags(tag_id, tags(*))')
        .eq('trip_id', tripData.id);

      setPlaces((placesData ?? []).map((p: Place & { place_tags?: Array<{ tags: unknown }> }) => ({
        ...p,
        tags: (p.place_tags ?? []).map(pt => pt.tags),
      })) as Place[]);

      const { data: tagsData } = await supabase.from('tags').select('*').eq('trip_id', tripData.id);
      setTags(tagsData ?? []);
    };
    load();
  }, [shareToken]);

  if (error) return (
    <div className="shared-error">
      <Lock size={40} />
      <p>{error}</p>
    </div>
  );

  if (!trip) return <div className="loading-spinner" />;

  return (
    <div className="trip-view">
      <div className="trip-topbar">
        <MapPin size={20} />
        <h1 className="trip-topbar-title">{trip.name}</h1>
        <span className="readonly-badge">Read-only</span>
      </div>

      <div className="trip-content">
        <MapView
          places={places}
          selectedPlace={selectedPlace}
          activeTags={[]}
          allTags={tags}
          onSelectPlace={setSelectedPlace}
        />
      </div>

      {selectedPlace && (
        <PlaceDetailSheet
          place={selectedPlace}
          allTags={tags}
          onClose={() => setSelectedPlace(null)}
          onToggleVisited={() => {}}
          onUpdate={() => {}}
          onDelete={() => {}}
          onSetTags={() => {}}
          onAddImage={async () => null}
          onRemoveImage={() => {}}
          readOnly
        />
      )}
    </div>
  );
}
