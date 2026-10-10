import { useState, useRef, useCallback, useEffect } from 'react';
import { Search, X } from 'lucide-react';
import type { GooglePlacePrediction } from '../types';
import { spanFromViewport } from '../lib/anchor';
import { extractMapsUrl, resolveMapsLink, type LinkedPlace } from '../lib/mapsLink';

// Shared by both things the field can be doing — an autocomplete query and a
// pasted link — so neither fires while someone is still typing.
const DEBOUNCE_MS = 250;

// Matches placeLookup's own wait for the same script, for the same reason: if
// it never arrives there is no telling whether it was blocked, keyless or just
// slow, so a generous ceiling and then an answer.
const GOOGLE_READY_TIMEOUT_MS = 8000;

/**
 * What to say when Google answers with something other than results.
 *
 * Worth saying at all because the alternative was saying nothing: every
 * failure here used to render as an empty dropdown, identical to "nothing
 * matched what you typed". A key whose Places API had been turned off looked
 * exactly like a search for a place that does not exist, and the only reason
 * it was ever diagnosed is that the map's long-press path bothers to report
 * its own failure.
 *
 * Phrased for the person running the instance, not an anonymous end user —
 * this is self-hosted, so whoever sees this is also whoever can go and look at
 * the key. ZERO_RESULTS is deliberately absent: that is a real answer, and an
 * empty dropdown is the right way to show it.
 */
// Keyed off the enum's member names rather than the enum itself: the
// getPlacePredictions callback is typed with the string union, not
// PlacesServiceStatus, so taking the enum type here does not compile. `keyof`
// keeps the list tied to the SDK's own, which is the part worth not drifting.
type PredictionStatus = keyof typeof google.maps.places.PlacesServiceStatus;

function statusMessage(status: PredictionStatus): string | null {
  if (status === 'ZERO_RESULTS') return null;
  if (status === 'REQUEST_DENIED') return 'Google refused the search — check the Places API key and its restrictions.';
  if (status === 'OVER_QUERY_LIMIT') return "Google's search quota is spent for now.";
  return 'Could not reach Google to search.';
}

// The way to add a place that needs no Google at all, which is worth pointing
// at precisely when Google is the thing that is broken.
const SEARCH_FALLBACK_HINT = 'You can still add a place by holding a spot on the map.';

const NOT_LOADED = 'Google search did not load.';

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
  // Set when Google answers with a failure, and cleared only when it answers
  // with results — NOT on the next keystroke. A denied key denies the next
  // request too, so clearing on input would flash the message off and back on
  // every character.
  const [searchError, setSearchError] = useState<string | null>(null);
  // Latched by the timeout below once the script is declared missing, so the
  // message can be re-asserted. Clearing the field resets searchError, and
  // without this the one failure no query can report would be gone for the
  // rest of the session: fetchPredictions returns before Google is ever asked,
  // so nothing else would put it back.
  const googleMissingRef = useRef(false);
  // The URL currently resolved or resolving, so that editing the text around
  // a link doesn't re-run it. Resolution costs a billed Find Place call, and
  // the field often holds more than the URL — "Café Central https://…" is
  // what sharing to Notes first produces — so typing in the prose either side
  // of it would otherwise bill again for a link that hasn't changed. Held
  // across a failure too; see the note at the resolve below.
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

  // The script's own absence, which no query can report: fetchPredictions
  // returns at its first line when the service isn't there, so a missing key
  // or a blocked script left the field looking merely unhelpful. Timed from
  // mount rather than from a keystroke, because the answer does not depend on
  // what was typed, and only asserted once the wait is over — the script
  // routinely arrives after the first few characters do.
  useEffect(() => {
    if (window.google?.maps?.places) return;
    const t = setTimeout(() => {
      if (window.google?.maps?.places) return;
      googleMissingRef.current = true;
      setSearchError(NOT_LOADED);
    }, GOOGLE_READY_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, []);

  const fetchPredictions = useCallback((value: string) => {
    if (!autocompleteService.current) {
      // Silent while the script may still be on its way — the wait above has
      // not finished, and a message at 250ms would be a guess.
      if (googleMissingRef.current) setSearchError(NOT_LOADED);
      return;
    }
    const seq = ++requestSeqRef.current;
    autocompleteService.current.getPlacePredictions(
      { input: value, sessionToken: sessionToken.current ?? undefined },
      (results, status) => {
        if (seq !== requestSeqRef.current) return; // superseded or cleared
        if (status === google.maps.places.PlacesServiceStatus.OK && results) {
          setPredictions(results as unknown as GooglePlacePrediction[]);
          setSearchError(null);
          setOpen(true);
          return;
        }
        setPredictions([]);
        setSearchError(statusMessage(status));
      }
    );
  }, []);

  const handleInput = (value: string) => {
    setQuery(value);

    // A pasted Google Maps link is not a search term — sending it to
    // autocomplete returns nothing at all. Resolve it instead, and take the
    // in-flight autocomplete down with the same seq bump the clear path uses
    // so a late response can't reopen the dropdown over the link's result.
    const mapsUrl = extractMapsUrl(value);
    if (mapsUrl) {
      // Same link as last time — editing the prose around it, or adding a
      // trailing space. Leave the pending resolve running. The debounce is
      // deliberately NOT cleared before this check: doing so cancelled the
      // timer and then returned without arming a new one, so a keystroke
      // inside the debounce window left the panel on "Reading that link…"
      // with nothing scheduled to finish it.
      if (mapsUrl === linkUrlRef.current) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      linkUrlRef.current = mapsUrl;
      const seq = ++requestSeqRef.current;
      setPredictions([]);
      setOpen(false);
      // Shown at once, while the call itself waits out the same debounce
      // autocomplete uses. Resolving costs a billed Find Place, and a link in
      // the field is still editable: one backspace truncates the URL into a
      // different (broken) one, and retyping the character makes a third.
      // linkUrlRef alone doesn't cover that — it only suppresses a value
      // identical to the last.
      setLink({ status: 'resolving' });
      // A failure deliberately leaves linkUrlRef holding this URL. Clearing
      // it — to let an identical re-paste retry — meant every later keystroke
      // took the "changed link" branch instead, so someone typing a note
      // around a link that failed re-invoked the function on each one,
      // flapping the panel between the error and "Reading that link…" and
      // billing a Place Details call per retry on the paths that reach
      // Google. The gesture that was supposed to buy back cannot happen
      // anyway: React only fires onChange when the field's value actually
      // changes, so select-all-and-paste-the-same-text is silent here. The
      // retry that does work is the clear button, or any edit that genuinely
      // changes the URL.
      debounceRef.current = setTimeout(() => {
        resolveMapsLink(mapsUrl)
          .then(result => {
            if (seq !== requestSeqRef.current) return;
            setLink(result.ok
              ? { status: 'ready', place: result.place }
              : { status: 'error', reason: result.reason });
          })
          // resolveMapsLink guards its own network call, but the Google SDK
          // path behind it can still reject — getServices memoises a rejected
          // promise for the rest of the session if a constructor throws.
          // Without this the panel sits on "Reading that link…" forever.
          .catch(() => {
            if (seq !== requestSeqRef.current) return;
            setLink({ status: 'error', reason: 'Could not read that link' });
          });
      }, DEBOUNCE_MS);
      return;
    }

    // Back to being a search — including when the link is edited away, which
    // has to drop the panel rather than leave it hanging under a query it no
    // longer matches.
    if (debounceRef.current) clearTimeout(debounceRef.current);

    // Unconditional, and deliberately not folded into the ref check below:
    // gating the panel on the ref is what once left a stale error row pinned
    // over every later query, hiding the predictions behind it. React bails
    // on a no-op set, so paying this per keystroke is free.
    setLink(null);

    // The seq bump is what actually cancels a resolution in flight. Leaving
    // it to fetchPredictions is not enough: that runs a debounce later at the
    // earliest, and it returns before bumping when the Maps script hasn't
    // loaded — so a link resolving in the meantime (which needs no Google at
    // all to reach its name-and-pin fallback) would reopen the panel over an
    // unrelated query, offering a place that a tap would add.
    if (linkUrlRef.current !== null) {
      requestSeqRef.current++;
      linkUrlRef.current = null;
    }

    if (!value.trim()) {
      // Invalidate any in-flight request too — its late response would
      // otherwise re-open the dropdown over an empty input.
      requestSeqRef.current++;
      setPredictions([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(() => fetchPredictions(value), DEBOUNCE_MS);
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
    // Cleared with everything else, so the X empties the panel rather than
    // leaving a message standing over an empty field. It comes back on the
    // next request that earns it — including the script-missing one, via
    // googleMissingRef.
    setSearchError(null);
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
  // A failure Google reported is worth a row of its own, but only while the
  // field has nothing better to show: predictions that arrived after it clear
  // it anyway, and a pasted link owns the panel outright.
  const showSearchError = searchError !== null && !link && !showPredictions;
  const showPanel = showPredictions || link !== null || showSearchError;

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
          ) : showSearchError ? (
            <ul className="predictions-list">
              <li className="prediction-status prediction-status--error">
                {searchError}
                {/* The escape hatch, named here because this is exactly when
                    it matters: a custom place off a long press needs no Google
                    at all, so the trip is not blocked by the key being wrong. */}
                <span className="prediction-status-hint">{SEARCH_FALLBACK_HINT}</span>
              </li>
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
