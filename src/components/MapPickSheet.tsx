import { useState, useEffect, useRef } from 'react';
import { X, MapPin, PencilLine, ArrowLeft } from 'lucide-react';
import { useSwipeToClose } from '../hooks/useSwipeToClose';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { lookupPoint, formatDistance } from '../lib/placeLookup';
import type { NearbyPlace, PickedPoint, PointLookup } from '../types';

interface Props {
  point: PickedPoint;
  onAdd: (place: {
    name: string;
    address?: string;
    latitude: number;
    longitude: number;
    google_place_id?: string;
    image_url?: string;
    notes?: string;
    types?: string[];
    spanKm?: number;
  }) => Promise<boolean>;
  onClose: () => void;
}

// The sheet mounts mid-press, 500ms into a touch that is still in progress and
// before the finger lifts. The compatibility mouse click the browser then
// synthesises can be hit-tested against the *current* DOM rather than
// retargeted to the original touchstart target, in which case it lands on the
// freshly-mounted overlay and closes the sheet the press just opened. Ignoring
// backdrop clicks for a beat after mount costs nothing and removes it.
const BACKDROP_ARM_MS = 400;

// Opened by a long-press on the map. Offers both ways to turn a bare
// coordinate into a place: pick one of the POIs Google knows about there, or
// name the spot yourself when it isn't on Google at all (a viewpoint, a
// friend's flat, the bench you liked).
export function MapPickSheet({ point, onAdd, onClose }: Props) {
  const [lookup, setLookup] = useState<PointLookup | null>(null);
  const [mode, setMode] = useState<'pick' | 'custom'>('pick');
  const [name, setName] = useState(point.hintName ?? '');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { sheetRef, handleProps } = useSwipeToClose(onClose);
  const nameInputRef = useRef<HTMLInputElement>(null);
  useEscapeClose(onClose);

  // Keyed on the coordinates so a second long-press elsewhere re-runs this;
  // the point object itself is re-created by TripView on every render.
  useEffect(() => {
    let cancelled = false;
    setLookup(null);
    lookupPoint({ lat: point.lat, lng: point.lng }).then(result => {
      if (cancelled) return;
      setLookup(result);
      // Only ever *prefill* an untouched field — never clobber something the
      // user has already typed while the lookup was in flight.
      setAddress(prev => (prev ? prev : result.address ?? ''));
    });
    return () => { cancelled = true; };
  }, [point.lat, point.lng]);

  useEffect(() => {
    if (mode === 'custom') nameInputRef.current?.focus();
  }, [mode]);

  // See BACKDROP_ARM_MS — the press that opened this sheet hasn't ended yet.
  const armedRef = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => { armedRef.current = true; }, BACKDROP_ARM_MS);
    return () => clearTimeout(t);
  }, []);

  const submit = async (place: Parameters<Props['onAdd']>[0]) => {
    if (submitting) return;
    setSubmitting(true);
    // onAdd closes this sheet only when the insert succeeded. On failure it
    // returns false and leaves us mounted, so the buttons must come back —
    // the user still has their typed form and can retry.
    const added = await onAdd(place);
    if (!added) setSubmitting(false);
  };

  const addNearby = (p: NearbyPlace) => submit({
    name: p.name,
    address: p.address,
    latitude: p.latitude,
    longitude: p.longitude,
    google_place_id: p.place_id,
    image_url: p.image_url,
    types: p.types,
    spanKm: p.spanKm,
  });

  const addCustom = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    submit({
      name: trimmed,
      address: address.trim() || undefined,
      // The exact spot pressed, not a POI's centroid — the whole point of
      // a custom place is that it sits where nothing is mapped.
      latitude: point.lat,
      longitude: point.lng,
      notes: notes.trim() || undefined,
    });
  };

  const coords = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
  const nearby = lookup?.nearby ?? [];
  const lookupFailed = !!lookup && !lookup.ok;

  return (
    <div className="bottom-sheet-overlay" onClick={() => { if (armedRef.current) onClose(); }}>
      <div
        className="bottom-sheet"
        ref={sheetRef}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Add a place here"
      >
        <div className="bottom-sheet-handle" {...handleProps} />

        <div className="sheet-header-row">
          {mode === 'custom' && (
            <button className="btn-icon" onClick={() => setMode('pick')} aria-label="Back">
              <ArrowLeft size={20} />
            </button>
          )}
          <h2 className="bottom-sheet-title">
            {mode === 'custom' ? 'Custom place' : 'Add a place here'}
          </h2>
          <button className="sheet-close" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>

        <p className="pick-point-address">
          {lookup ? (lookup.address ?? coords) : 'Locating…'}
        </p>

        {/* The custom path is the one that still works with Google down, so
            lead with it rather than leaving the user on a dead end. */}
        {lookupFailed && mode === 'pick' && (
          <button className="btn-primary pick-custom-btn u-mb8" onClick={() => setMode('custom')}>
            <PencilLine size={16} />
            Name this spot yourself
          </button>
        )}

        {mode === 'pick' ? (
          <>
            {!lookup && <p className="pick-status">Looking around…</p>}

            {lookup && nearby.length > 0 && (
              <>
                <h3 className="pick-section-label">What's here?</h3>
                <ul className="pick-poi-list">
                  {nearby.map(p => (
                    <li key={p.place_id}>
                      <button
                        className="pick-poi"
                        onClick={() => addNearby(p)}
                        disabled={submitting}
                      >
                        {p.image_url
                          ? <img className="pick-poi-thumb" src={p.image_url} alt="" loading="lazy" />
                          : <span className="pick-poi-thumb pick-poi-thumb--empty"><MapPin size={16} /></span>}
                        <span className="pick-poi-text">
                          <span className="prediction-main">{p.name}</span>
                          {p.address && <span className="prediction-sub">{p.address}</span>}
                        </span>
                        <span className="pick-poi-distance">{formatDistance(p.distance)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="predictions-attribution">powered by Google</p>
              </>
            )}

            {/* Two genuinely different states. Only the first is a statement
                about the world; the second is a statement about us. */}
            {lookup && lookup.ok && nearby.length === 0 && (
              <p className="pick-status">Google doesn't list anything within 150 m of this spot.</p>
            )}

            {lookupFailed && (
              <p className="pick-status">
                Couldn't reach Google to see what's here. You can still add this spot yourself.
              </p>
            )}

            <button className="btn-secondary pick-custom-btn" onClick={() => setMode('custom')}>
              <PencilLine size={16} />
              Add a custom place
            </button>
          </>
        ) : (
          <>
            <input
              ref={nameInputRef}
              type="text"
              className="input u-mb8"
              placeholder="Name (e.g. the viewpoint)"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && addCustom()}
            />
            <input
              type="text"
              className="input u-mb8"
              placeholder="Address (optional)"
              value={address}
              onChange={e => setAddress(e.target.value)}
            />
            <textarea
              className="input u-mb8"
              rows={2}
              placeholder="Notes (optional)"
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
            <p className="pick-status">Saved at {coords}</p>
            <button
              className="btn-primary pick-custom-btn"
              onClick={addCustom}
              disabled={!name.trim() || submitting}
            >
              {submitting ? 'Adding…' : 'Add place'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
