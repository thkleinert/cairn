import { useState, useRef } from 'react';
import { Plus, Trash2, GripVertical } from 'lucide-react';
import { useDragReorder } from '../hooks/useDragReorder';
import { MentionTextarea } from './MentionTextarea';
import { parseMentions } from '../lib/mentions';
import type { Place, TripNote } from '../types';

interface Props {
  notes: TripNote[];
  places: Place[];
  onAdd: (body: string) => Promise<unknown> | void;
  onUpdate: (id: string, body: string) => Promise<unknown> | void;
  onRemove: (id: string) => Promise<unknown> | void;
  onReorder: (orderedIds: string[]) => void;
  /** Tapping an @mention jumps to that place. Omit to render mentions inert. */
  onSelectPlace?: (placeId: string) => void;
  readOnly?: boolean;
  addPlaceholder?: string;
  emptyText?: string;
}

// A flat bullet list. Each bullet is its own row in the database, so it can be
// edited, reordered and deleted on its own — and two people editing different
// bullets don't overwrite each other, which a single text field could not do.
export function NoteList({
  notes, places, onAdd, onUpdate, onRemove, onReorder, onSelectPlace,
  readOnly = false, addPlaceholder = 'Add a note…', emptyText,
}: Props) {
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  // Guards the window between submitting a bullet and the list re-rendering
  // with it — without this, a fast double Enter posts the same text twice.
  const addingRef = useRef(false);

  const { order, dragId, suppressTransition, handlePointerDown, handlePointerMove, handlePointerUp, getRowOffsetPx } =
    useDragReorder({
      items: notes,
      getId: (n: TripNote) => n.id,
      onReorder,
      enabled: !readOnly && !editingId && notes.length > 1,
    });

  const commitAdd = async () => {
    const body = draft.trim();
    if (!body || addingRef.current) return;
    addingRef.current = true;
    setDraft('');
    await onAdd(body);
    addingRef.current = false;
  };

  const startEdit = (note: TripNote) => {
    if (readOnly) return;
    setEditingId(note.id);
    setEditDraft(note.body);
  };

  const commitEdit = async () => {
    const id = editingId;
    if (!id) return;
    const body = editDraft;
    setEditingId(null);
    // An emptied bullet deletes itself — the hook routes a blank body to
    // onRemove, since a blank row can't be stored and shouldn't be shown.
    if (body.trim() !== notes.find(n => n.id === id)?.body) await onUpdate(id, body);
  };

  const renderBody = (body: string) =>
    parseMentions(body, places).map((seg, i) =>
      seg.type === 'mention' && seg.place ? (
        <span
          key={i}
          className={`mention-chip ${onSelectPlace ? '' : 'mention-chip--inert'}`}
          role={onSelectPlace ? 'link' : undefined}
          tabIndex={onSelectPlace ? 0 : undefined}
          onClick={e => { if (onSelectPlace) { e.stopPropagation(); onSelectPlace(seg.place!.id); } }}
          onKeyDown={e => {
            if (onSelectPlace && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault(); e.stopPropagation(); onSelectPlace(seg.place!.id);
            }
          }}
        >
          @{seg.value}
        </span>
      ) : (
        <span key={i}>{seg.value}</span>
      )
    );

  return (
    <div className="note-list">
      {notes.length === 0 && emptyText && (
        <p className="pick-status note-list-empty">{emptyText}</p>
      )}

      <ul className="note-bullets">
        {order.map((note, i) => {
          const isDragging = dragId === note.id;
          const offset = getRowOffsetPx(i, note.id);
          return (
            <li
              key={note.id}
              className={`note-bullet ${isDragging ? 'note-bullet--dragging' : ''}`}
              style={{
                transform: isDragging ? undefined : `translateY(${offset}px)`,
                transition: suppressTransition ? 'none' : undefined,
              }}
              onPointerMove={isDragging ? handlePointerMove : undefined}
              onPointerUp={isDragging ? handlePointerUp : undefined}
            >
              {!readOnly && notes.length > 1 && (
                <span
                  className="note-bullet-grip"
                  aria-hidden="true"
                  onPointerDown={e =>
                    handlePointerDown(note.id, i, e.currentTarget.parentElement as HTMLElement, e)
                  }
                >
                  <GripVertical size={15} />
                </span>
              )}
              {(readOnly || notes.length <= 1) && <span className="note-bullet-dot" aria-hidden="true" />}

              {editingId === note.id ? (
                <MentionTextarea
                  value={editDraft}
                  onChange={setEditDraft}
                  onSubmit={commitEdit}
                  onBlur={commitEdit}
                  onCancel={() => setEditingId(null)}
                  places={places}
                  autoFocus
                  ariaLabel="Edit note"
                  className="note-bullet-input"
                />
              ) : (
                <span
                  className="note-bullet-body"
                  onClick={() => startEdit(note)}
                  role={readOnly ? undefined : 'button'}
                  tabIndex={readOnly ? undefined : 0}
                  onKeyDown={e => {
                    if (!readOnly && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); startEdit(note); }
                  }}
                >
                  {renderBody(note.body)}
                </span>
              )}

              {!readOnly && editingId !== note.id && (
                <button
                  type="button"
                  className="note-bullet-delete"
                  aria-label={`Delete note: ${note.body.slice(0, 40)}`}
                  onClick={() => onRemove(note.id)}
                >
                  <Trash2 size={15} />
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {!readOnly && (
        <div className="note-add-row">
          <Plus size={16} className="note-add-icon" />
          <MentionTextarea
            value={draft}
            onChange={setDraft}
            onSubmit={commitAdd}
            // Deliberately not onBlur: committing on blur would post a
            // half-typed bullet every time the keyboard dismissed.
            places={places}
            placeholder={addPlaceholder}
            ariaLabel="Add a note"
            className="note-add-input"
          />
          {draft.trim() && (
            <button type="button" className="btn-icon btn-icon-sm" onClick={commitAdd} aria-label="Add note">
              <Plus size={18} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
