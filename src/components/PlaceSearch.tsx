import { useState, useRef, useCallback, useEffect } from 'react';
import { Search, X } from 'lucide-react';
import type { GooglePlacePrediction } from '../types';

declare global {
  interface Window {
    google: typeof google;
  }
}

interface Props {
  onSelect: (place: {
    name: string;
    address: string;
    latitude: number;
    longitude: number;
    google_place_id: string;
    image_url?: string;
  }) => void;
}

export function PlaceSearch({ onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [predictions, setPredictions] = useState<GooglePlacePrediction[]>([]);
  const [open, setOpen] = useState(false);
  const autocompleteService = useRef<google.maps.places.AutocompleteService | null>(null);
  const placesService = useRef<google.maps.places.PlacesService | null>(null);
  const sessionToken = useRef<google.maps.places.AutocompleteSessionToken | null>(null);
  const divRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const initServices = useCallback(() => {
    if (!window.google?.maps?.places) return;
    if (!autocompleteService.current) {
      autocompleteService.current = new google.maps.places.AutocompleteService();
    }
    if (!placesService.current && divRef.current) {
      placesService.current = new google.maps.places.PlacesService(divRef.current);
    }
    if (!sessionToken.current) {
      sessionToken.current = new google.maps.places.AutocompleteSessionToken();
    }
  }, []);

  useEffect(() => {
    // main.tsx dispatches this when the Google Maps script finishes loading
    if (window.google?.maps?.places) {
      initServices();
      return;
    }
    window.addEventListener('gmaps-loaded', initServices);
    return () => window.removeEventListener('gmaps-loaded', initServices);
  }, [initServices]);

  const fetchPredictions = useCallback((value: string) => {
    if (!autocompleteService.current) return;
    autocompleteService.current.getPlacePredictions(
      { input: value, sessionToken: sessionToken.current ?? undefined },
      (results, status) => {
        if (status === google.maps.places.PlacesServiceStatus.OK && results) {
          setPredictions(results as unknown as GooglePlacePrediction[]);
          setOpen(true);
        } else {
          setPredictions([]);
        }
      }
    );
  }, []);

  const handleInput = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!value.trim()) {
      setPredictions([]);
      return;
    }
    debounceRef.current = setTimeout(() => fetchPredictions(value), 250);
  };

  const handleSelect = (prediction: GooglePlacePrediction) => {
    if (!placesService.current) return;
    placesService.current.getDetails(
      {
        placeId: prediction.place_id,
        fields: ['name', 'formatted_address', 'geometry', 'photos'],
        sessionToken: sessionToken.current ?? undefined,
      },
      (result, status) => {
        if (status === google.maps.places.PlacesServiceStatus.OK && result) {
          sessionToken.current = new google.maps.places.AutocompleteSessionToken();
          const image_url = result.photos?.[0]?.getUrl({ maxWidth: 800 });
          onSelect({
            name: result.name ?? prediction.structured_formatting.main_text,
            address: result.formatted_address ?? prediction.description,
            latitude: result.geometry!.location!.lat(),
            longitude: result.geometry!.location!.lng(),
            google_place_id: prediction.place_id,
            image_url,
          });
          setQuery('');
          setPredictions([]);
          setOpen(false);
        }
      }
    );
  };

  const clear = () => {
    setQuery('');
    setPredictions([]);
    setOpen(false);
  };

  return (
    <div className="place-search">
      <div ref={divRef} style={{ display: 'none' }} />
      <div className="search-input-wrap">
        <Search size={18} className="search-icon" />
        <input
          type="text"
          className="search-input"
          placeholder="Search places…"
          value={query}
          onChange={e => handleInput(e.target.value)}
          onFocus={() => predictions.length > 0 && setOpen(true)}
          autoFocus
        />
        {query && (
          <button className="search-clear" onClick={clear} aria-label="Clear">
            <X size={16} />
          </button>
        )}
      </div>
      {open && predictions.length > 0 && (
        <ul className="predictions-list">
          {predictions.map(p => (
            <li key={p.place_id}>
              <button className="prediction-item" onClick={() => handleSelect(p)}>
                <span className="prediction-main">{p.structured_formatting.main_text}</span>
                <span className="prediction-sub">{p.structured_formatting.secondary_text}</span>
              </button>
            </li>
          ))}
          <li className="predictions-attribution">powered by Google</li>
        </ul>
      )}
    </div>
  );
}
