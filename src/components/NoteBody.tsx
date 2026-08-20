import { ExternalLink } from 'lucide-react';
import { parseNoteBody, displayHost } from '../lib/mentions';
import type { Place } from '../types';

interface Props {
  body: string;
  places: Place[];
  /** Tapping an @mention jumps to that place. Omit to render mentions inert. */
  onSelectPlace?: (placeId: string) => void;
}

// One note's text: prose, @mentions of places, and links. Shared by the
// editable outline and the read-only shared trip page so a note reads the same
// in both — the shared page used to render the raw string, which showed a
// booking URL as forty characters of path.
export function NoteBody({ body, places, onSelectPlace }: Props) {
  return (
    <>
      {parseNoteBody(body, places).map((seg, i) => {
        if (seg.type === 'url') {
          return (
            <a
              key={i}
              className="note-link"
              href={seg.href}
              target="_blank"
              rel="noopener noreferrer"
              // Without this the tap falls through to the row and opens the
              // editor behind the newly-opened tab.
              onClick={e => e.stopPropagation()}
              onPointerDown={e => e.stopPropagation()}
            >
              <ExternalLink size={11} /> {displayHost(seg.href!)}
            </a>
          );
        }
        if (seg.type === 'mention' && seg.place) {
          return (
            <span
              key={i}
              className={`mention-chip ${onSelectPlace ? '' : 'mention-chip--inert'}`}
              role={onSelectPlace ? 'link' : undefined}
              tabIndex={onSelectPlace ? 0 : undefined}
              onClick={e => {
                if (onSelectPlace) { e.stopPropagation(); onSelectPlace(seg.place!.id); }
              }}
              onKeyDown={e => {
                if (onSelectPlace && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault(); e.stopPropagation(); onSelectPlace(seg.place!.id);
                }
              }}
            >
              @{seg.value}
            </span>
          );
        }
        return <span key={i}>{seg.value}</span>;
      })}
    </>
  );
}
