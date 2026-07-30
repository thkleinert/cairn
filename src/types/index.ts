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
