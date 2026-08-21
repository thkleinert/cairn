import { useState, useRef, useCallback, useEffect } from 'react';
import { Search, X } from 'lucide-react';
import type { GooglePlacePrediction } from '../types';
import { spanFromViewport } from '../lib/anchor';

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
    types?: string[];
    spanKm?: number;
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
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Google's callback API can answer out of order (or after the input was
  // cleared) — only the latest request may touch state, otherwise a slow
  // response re-opens the dropdown with a stale query's results.
  const requestSeqRef = useRef(0);

  // Deliberately not autoFocus: focusing immediately pops the keyboard up
  // while the bottom pill is still mid-grow, and the two animations fight
  // each other. Wait for the pill's grow transition (0.35s) to settle first.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 350);
    return () => clearTimeout(t);
  }, []);

  // The debounce must not fire into an unmounted component.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

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
    const seq = ++requestSeqRef.current;
    autocompleteService.current.getPlacePredictions(
      { input: value, sessionToken: sessionToken.current ?? undefined },
      (results, status) => {
        if (seq !== requestSeqRef.current) return; // superseded or cleared
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
      // Invalidate any in-flight request too — its late response would
      // otherwise re-open the dropdown over an empty input.
      requestSeqRef.current++;
      setPredictions([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(() => fetchPredictions(value), 250);
  };

  const handleSelect = (prediction: GooglePlacePrediction) => {
    if (!placesService.current) return;
    placesService.current.getDetails(
      {
        placeId: prediction.place_id,
        // `types` is an Essentials-tier field and this call is already Pro
        // tier because of `photos`, so asking for it costs nothing.
        fields: ['name', 'formatted_address', 'geometry', 'photos', 'types'],
        sessionToken: sessionToken.current ?? undefined,
      },
      (result, status) => {
        // geometry is genuinely optional in Google's response — a result
        // without coordinates can't become a map pin, and asserting through
        // it would throw inside this callback where nothing catches it.
        const location = result?.geometry?.location;
        if (status === google.maps.places.PlacesServiceStatus.OK && result && location) {
          sessionToken.current = new google.maps.places.AutocompleteSessionToken();
          const image_url = result.photos?.[0]?.getUrl({ maxWidth: 800 });
          onSelect({
            name: result.name ?? prediction.structured_formatting.main_text,
            address: result.formatted_address ?? prediction.description,
            latitude: location.lat(),
            longitude: location.lng(),
            google_place_id: prediction.place_id,
            image_url,
            types: result.types,
            // Free: `geometry` is already requested, and the viewport rides
            // along with it. This is what keeps a national park a stop.
            spanKm: spanFromViewport(result.geometry?.viewport),
          });
          setQuery('');
          setPredictions([]);
          setOpen(false);
        }
      }
    );
  };

  const clear = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    requestSeqRef.current++;
    setQuery('');
    setPredictions([]);
    setOpen(false);
  };

  const showPredictions = open && predictions.length > 0;

  return (
    <div className="place-search">
      <div ref={divRef} style={{ display: 'none' }} />
      {/* Grid-row trick: animates smoothly between 0 and content height
          without ever transitioning to/from `auto`, so the outer shell
          (which has no fixed height of its own beyond a min-height) can
          grow to fit this in normal layout flow — no separate floating
          card, no manual alignment against the bar below. */}
      <div className={`predictions-grid ${showPredictions ? 'predictions-grid--open' : ''}`}>
        <div className="predictions-grid-inner">
          {showPredictions && (
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
      </div>
      <div className="search-input-wrap">
        <Search size={18} className="search-icon" />
        <input
          ref={inputRef}
          type="text"
          className="search-input"
          placeholder="Search places…"
          value={query}
          onChange={e => handleInput(e.target.value)}
          onFocus={() => predictions.length > 0 && setOpen(true)}
        />
        {query && (
          <button className="search-clear" onClick={clear} aria-label="Clear">
            <X size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
