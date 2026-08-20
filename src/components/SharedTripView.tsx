import { useEffect, useState, lazy } from 'react';
import { MapPin, Lock } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { Trip, Place, Tag } from '../types';
import { PlaceDetailSheet } from './PlaceDetailSheet';
import { MapBoundary } from './MapBoundary';

const MapView = lazy(() => import('./MapView').then(m => ({ default: m.MapView })));

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
      // One token-scoped RPC returns trip + places (tags/images nested) +
      // tags. Direct table reads can't work here: an anonymous visitor fails
      // every membership-based RLS policy.
      const { data, error: rpcError } = await supabase.rpc('get_shared_trip', {
        p_token: shareToken,
      });
      if (rpcError || !data) {
        setError('Trip not found or link is invalid.');
        return;
      }
      const payload = data as { trip: Trip; places: Place[]; tags: Tag[] };
      setTrip(payload.trip);
      setPlaces(payload.places);
      setTags(payload.tags);
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
        <MapBoundary>
          <MapView
            places={places}
            selectedPlace={selectedPlace}
            activeTags={[]}
            allTags={tags}
            onSelectPlace={setSelectedPlace}
          />
        </MapBoundary>
      </div>

      {selectedPlace && (
        <PlaceDetailSheet
          place={selectedPlace}
          allTags={tags}
          onClose={() => setSelectedPlace(null)}
          onToggleVisited={() => {}}
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
