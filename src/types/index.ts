export type PlaceStatus = 'planned' | 'visited';

export interface Trip {
  id: string;
  name: string;
  description?: string;
  // Trip-wide scratchpad, distinct from `description` (the short subtitle in
  // the trip list). Deliberately absent from the public shared view — see the
  // scrub in get_shared_trip.
  notes?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  cover_image_url?: string | null;
  owner_id: string;
  created_at: string;
  updated_at: string;
  // Client-side: true when the trip has more than one member (you shared it,
  // or it was shared with you). Derived in useTrips, not a DB column.
  is_shared?: boolean;
}

export interface Tag {
  id: string;
  trip_id: string;
  name: string;
  color: string;
  icon?: string;
}

export interface PlaceImage {
  id: string;
  place_id: string;
  url: string;
  caption?: string;
  position: number;
  created_at: string;
}

export interface PlaceComment {
  id: string;
  place_id: string;
  user_id: string;
  email: string;
  body: string;
  created_at: string;
}

export interface Place {
  id: string;
  trip_id: string;
  name: string;
  address?: string;
  latitude: number;
  longitude: number;
  google_place_id?: string;
  status: PlaceStatus;
  visited_at?: string | null;
  notes?: string | null;
  source_urls: string[];
  image_url?: string;
  added_by?: string;
  position: number;
  created_at: string;
  updated_at: string;
  tags?: Tag[];
  images?: PlaceImage[];
}

export interface GooglePlacePrediction {
  place_id: string;
  description: string;
  structured_formatting: {
    main_text: string;
    secondary_text: string;
  };
}

// A point the user long-pressed on the map. `hintName` is the POI label
// Mapbox had already rendered under their finger, if any — free, instant,
// and available before the Google lookup resolves.
export interface PickedPoint {
  lat: number;
  lng: number;
  hintName?: string;
}

// A Google POI found around a picked point.
export interface NearbyPlace {
  place_id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  /** Metres from the picked point. */
  distance: number;
  image_url?: string;
}

export interface PointLookup {
  address: string | null;
  nearby: NearbyPlace[];
  // False when Google never answered (script blocked, quota exhausted, key
  // rejected, network down). An empty `nearby` means "nothing within 150 m"
  // ONLY when this is true — otherwise the UI would state a failure as a fact
  // about the world, and the result must not be cached.
  ok: boolean;
}
