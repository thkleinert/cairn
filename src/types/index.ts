export type PlaceStatus = 'planned' | 'visited';

export interface Trip {
  id: string;
  name: string;
  description?: string;
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

// One bullet. `place_id` null means it belongs to the whole trip; set means
// it belongs to that place. Rows rather than a text blob so two members
// editing notes at once don't silently overwrite each other.
export interface TripNote {
  id: string;
  trip_id: string;
  place_id?: string | null;
  body: string;
  position: number;
  /**
   * Nesting level, 0 at the outer edge. The outline is a flat ordered list
   * plus a depth rather than a parent_id tree — an item's parent is the
   * nearest item above it with a smaller depth. A depth more than one past
   * its predecessor's is impossible in an outline but expressible here, so
   * rendering clamps it (see normaliseDepths).
   */
  depth: number;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export type PlaceKind = 'stop' | 'spot';

/**
 * When you are at a stop, and for how long.
 *
 * A row per visit rather than dates on the place, because a place can be
 * visited more than once — a loop comes back through where it started, and a
 * trip often opens and closes in the same city.
 *
 * Only stops have these. A spot is inside a stop, and it is the stop you
 * arrive at; the spots under it inherit that window.
 */
export interface PlaceVisit {
  id: string;
  trip_id: string;
  place_id: string;
  /** `YYYY-MM-DD`. A date, not a timestamp: a stay has no time zone. */
  starts_on: string;
  /** Null means a single day, not an open-ended stay. */
  ends_on: string | null;
  created_at: string;
  updated_at: string;
}

export interface Place {
  id: string;
  trip_id: string;
  name: string;
  address?: string;
  latitude: number;
  longitude: number;
  google_place_id?: string;
  /**
   * The place this one sits inside — a café anchored to its city. Only the
   * notes page reads it, to nest this place under its parent's heading.
   * One level only: a place whose parent itself has a parent is treated as
   * top-level, which is also what stops a cycle hiding places entirely.
   */
  parent_place_id?: string | null;
  /**
   * What this place is: somewhere you go ('stop' — a city, an island, a park)
   * or somewhere inside one ('spot' — a café, a hotel, a viewpoint).
   * Only stops can be parents, and only spots can have one. The list view
   * nests by it and the map can hide spots entirely.
   */
  kind: PlaceKind;
  status: PlaceStatus;
  visited_at?: string | null;
  image_url?: string;
  added_by?: string;
  position: number;
  created_at: string;
  updated_at: string;
  tags?: Tag[];
  images?: PlaceImage[];
  // Only populated by get_shared_trip — the authenticated app reads bullets
  // through useTripNotes instead.
  note_items?: Pick<TripNote, 'id' | 'body' | 'position' | 'depth'>[];
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
  /** Google's classification, used once to decide stop vs spot. */
  types?: string[];
  /** How many km the place's recommended viewport spans, when Google gave one. */
  spanKm?: number;
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
