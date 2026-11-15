import { X, ChevronRight } from 'lucide-react';
import { useSwipeToClose } from '../hooks/useSwipeToClose';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { directionsOptions } from '../lib/directions';
import type { Place } from '../types';

interface Props {
  place: Place;
  onClose: () => void;
}

// Which app to navigate with, opened from the place sheet's Directions
// button. A choice rather than a guess at the right app: which one someone
// navigates with is a habit, not something the platform reveals, and an
// iPhone user with Google Maps is the ordinary case.
export function DirectionsSheet({ place, onClose }: Props) {
  const { sheetRef, handleProps } = useSwipeToClose(onClose);
  useEscapeClose(onClose);

  return (
    <div className="bottom-sheet-overlay" onClick={e => { e.stopPropagation(); onClose(); }}>
      <div
        className="bottom-sheet"
        ref={sheetRef}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Directions"
      >
        <div className="bottom-sheet-handle" {...handleProps} />
        <div className="sheet-header-row">
          <h2 className="bottom-sheet-title">Directions to {place.name}</h2>
          <button className="sheet-close" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>

        <ul className="directions-options">
          {directionsOptions(place).map(option => (
            <li key={option.id}>
              {/* A real link, not window.open from a handler: iOS only hands a
                  universal link to the installed app when the user taps an
                  anchor, and a standalone PWA would otherwise try to load
                  Google Maps inside itself. */}
              <a
                className="directions-option"
                href={option.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={onClose}
              >
                {option.label}
                <ChevronRight size={16} aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
