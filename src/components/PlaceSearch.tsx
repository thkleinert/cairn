import { useState, useRef, useCallback, useEffect } from 'react';
import { Search, X } from 'lucide-react';
import type { GooglePlacePrediction } from '../types';
import { spanFromViewport } from '../lib/anchor';
import { extractMapsUrl, resolveMapsLink, type LinkedPlace } from '../lib/mapsLink';

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
    // Optional because a pasted Maps link doesn't always resolve to one — a
    // place Google can't match by name still arrives with a name and a pin,
    // which is exactly the custom place the map's long-press path creates.
    google_place_id?: string;
    image_url?: string;
    types?: string[];
    spanKm?: number;
  }) => void;
}

// What a pasted Google Maps link is doing right now. Null means the field
// holds an ordinary search, which is the only state that talks to autocomplete.
type LinkState =
  | { status: 'resolving' }
  | { status: 'error'; reason: string }
  | { status: 'ready'; place: LinkedPlace };

export function PlaceSearch({ onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [predictions, setPredictions] = useState<GooglePlacePrediction[]>([]);
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<LinkState | null>(null);
  // The URL currently resolved or resolving, so that typing on either side of
  // a pasted link doesn't re-run it. Resolution costs a billed Find Place
  // call, and onChange fires on every keystroke — without this, nudging the
  // cursor after a paste would bill for the same link again.
  const linkUrlRef = useRef<string | null>(null);
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

    // A pasted Google Maps link is not a search term — sending it to
    // autocomplete returns nothing at all. Resolve it instead, and take the
    // in-flight autocomplete down with the same seq bump the clear path uses
    // so a late response can't reopen the dropdown over the link's result.
    const mapsUrl = extractMapsUrl(value);
    if (mapsUrl) {
      if (mapsUrl === linkUrlRef.current) return;
      linkUrlRef.current = mapsUrl;
      const seq = ++requestSeqRef.current;
      setPredictions([]);
      setOpen(false);
      setLink({ status: 'resolving' });
      resolveMapsLink(mapsUrl)
        .then(result => {
          if (seq !== requestSeqRef.current) return;
          setLink(result.ok
            ? { status: 'ready', place: result.place }
            : { status: 'error', reason: result.reason });
        })
        // resolveMapsLink guards its own network call, but the Google SDK
        // path behind it can still reject — getServices memoises a rejected
        // promise for the rest of the session if a constructor throws. Without
        // this the panel sits on "Reading that link…" forever.
        .catch(() => {
          if (seq !== requestSeqRef.current) return;
          setLink({ status: 'error', reason: 'Could not read that link' });
        });
      return;
    }

    // Back to being a search — including when the link is edited away, which
    // has to drop the resolved result rather than leave it hanging under a
    // query it no longer matches.
    //
    // The seq bump is what actually cancels the resolution in flight. Leaving
    // it to fetchPredictions is not enough: that runs 250ms later at the
    // earliest, and it returns before bumping when the Maps script hasn't
    // loaded — so a link resolving in the meantime (which needs no Google at
    // all to reach its name-and-pin fallback) would reopen the panel over an
    // unrelated query, offering a place that a tap would add.
    if (linkUrlRef.current !== null) {
      requestSeqRef.current++;
      linkUrlRef.current = null;
      setLink(null);
    }

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
    linkUrlRef.current = null;
    setQuery('');
    setPredictions([]);
    setLink(null);
    setOpen(false);
  };

  // Everything a resolved link already carries, handed over exactly as a
  // picked suggestion is — the shapes are the same by construction, so both
  // entry points land a place identically.
  const handleSelectLink = (place: LinkedPlace) => {
    onSelect(place);
    clear();
  };

  const showPredictions = open && predictions.length > 0;
  // The link panel takes over the dropdown whenever a link is in the field:
  // it is the only thing the field can act on at that moment, so there is
  // never anything to show alongside it.
  const showPanel = showPredictions || link !== null;

  return (
    <div className="place-search">
      <div ref={divRef} style={{ display: 'none' }} />
      {/* Grid-row trick: animates smoothly between 0 and content height
          without ever transitioning to/from `auto`, so the outer shell
          (which has no fixed height of its own beyond a min-height) can
          grow to fit this in normal layout flow — no separate floating
          card, no manual alignment against the bar below. */}
      <div className={`predictions-grid ${showPanel ? 'predictions-grid--open' : ''}`}>
        <div className="predictions-grid-inner">
          {link ? (
            <ul className="predictions-list">
              {link.status === 'resolving' && (
                <li className="prediction-status">Reading that link…</li>
              )}
              {link.status === 'error' && (
                <li className="prediction-status prediction-status--error">{link.reason}</li>
              )}
              {link.status === 'ready' && (
                <li>
                  <button className="prediction-item" onClick={() => handleSelectLink(link.place)}>
                    <span className="prediction-main">{link.place.name}</span>
                    {link.place.address && (
                      <span className="prediction-sub">{link.place.address}</span>
                    )}
                  </button>
                </li>
              )}
              {link.status !== 'error' && (
                <li className="predictions-attribution">powered by Google</li>
              )}
            </ul>
          ) : showPredictions && (
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
          placeholder="Search or paste a link…"
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
