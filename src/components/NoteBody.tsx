import { Fragment, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { parseNoteBody, displayHost, type NoteMark } from '../lib/mentions';
import type { Place } from '../types';

interface Props {
  body: string;
  places: Place[];
  /** Tapping an @mention jumps to that place. Omit to render mentions inert. */
  onSelectPlace?: (placeId: string) => void;
}

// The element each mark is drawn as. Semantic tags rather than styled spans:
// a note read aloud should sound emphasised, and a screen reader has no way to
// know that from a class name. Order is fixed and outermost-first so that the
// same mark set always produces the same DOM — "***x***" and "***x***" typed
// the other way round are one node either way — and so that <code> ends up
// innermost, where its own background sits inside the emphasis rather than
// clipping it.
const MARK_ORDER: readonly NoteMark[] = ['bold', 'italic', 'strike', 'code'];

function withMarks(node: ReactNode, marks: ReadonlySet<NoteMark> | undefined): ReactNode {
  if (!marks || marks.size === 0) return node;
  let out = node;
  // Built inside out, so the loop runs backwards over an outermost-first list.
  for (let i = MARK_ORDER.length - 1; i >= 0; i -= 1) {
    const mark = MARK_ORDER[i];
    if (!marks.has(mark)) continue;
    if (mark === 'bold') out = <strong>{out}</strong>;
    else if (mark === 'italic') out = <em>{out}</em>;
    else if (mark === 'strike') out = <s>{out}</s>;
    else out = <code className="note-code">{out}</code>;
  }
  return out;
}

// One note's text: prose, @mentions of places, links, and inline emphasis.
// Shared by the editable outline and the read-only shared trip page so a note
// reads the same in both — the shared page used to render the raw string,
// which showed a booking URL as forty characters of path.
export function NoteBody({ body, places, onSelectPlace }: Props) {
  return (
    <>
      {parseNoteBody(body, places).map((seg, i) => {
        let content: ReactNode;
        if (seg.type === 'url') {
          content = (
            <a
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
        } else if (seg.type === 'mention' && seg.place) {
          content = (
            <span
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
        } else {
          content = <span>{seg.value}</span>;
        }
        // The key rides on a Fragment rather than on `content`, because the
        // emphasis wrapper — when there is one — is what actually lands in the
        // list, and which element that is depends on the marks.
        return <Fragment key={i}>{withMarks(content, seg.marks)}</Fragment>;
      })}
    </>
  );
}
