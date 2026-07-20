export type TripStatus = 'planning' | 'ongoing' | 'completed';
export type PlaceStatus = 'planned' | 'visited';
export type MemberRole = 'owner' | 'editor' | 'viewer';

export interface Trip {
  id: string;
  name: string;
  description?: string;
  start_date?: string;
  end_date?: string;
  status: TripStatus;
  share_token: string;
  cover_image_url?: string | null;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface TripMember {
  id: string;
  trip_id: string;
  user_id: string;
  role: MemberRole;
  joined_at: string;
  profile?: Profile;
}

export interface Profile {
  id: string;
  email?: string;
  full_name?: string;
  avatar_url?: string;
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
  notes?: string;
  source_url?: string;
  image_url?: string;
  added_by?: string;
  position: number;
  created_at: string;
  updated_at: string;
  tags?: Tag[];
  images?: PlaceImage[];
}

export interface PlaceTag {
  place_id: string;
  tag_id: string;
}

export interface GooglePlacePrediction {
  place_id: string;
  description: string;
  structured_formatting: {
    main_text: string;
    secondary_text: string;
  };
}

export interface GooglePlaceDetail {
  place_id: string;
  name: string;
  formatted_address: string;
  geometry: {
    location: { lat: number; lng: number };
  };
  photos?: Array<{ getUrl: (opts: { maxWidth: number }) => string }>;
}
