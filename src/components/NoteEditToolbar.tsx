import { IndentDecrease, IndentIncrease, Trash2, Check } from 'lucide-react';

interface Props {
  canIndent: boolean;
  canOutdent: boolean;
  canDelete: boolean;
  onIndent: () => void;
  onOutdent: () => void;
  onDelete: () => void;
  onDone: () => void;
}

// The bar that sits on top of the keyboard while a bullet is being edited —
// where indent, outdent and delete live, since a phone keyboard has no Tab and
// the rows themselves carry no buttons any more.
//
// Anchored with --keyboard-inset (see viewport.js) rather than to the focused
// row: on iOS the layout viewport does not shrink for the keyboard, so a bar
// positioned any other way sits underneath it.
//
// Every button suppresses pointerdown. A button that takes focus dismisses the
// keyboard and blurs the textarea, which commits the edit and unmounts this
// bar — so the tap would land on nothing and the action would never run.
export function NoteEditToolbar({
  canIndent, canOutdent, canDelete, onIndent, onOutdent, onDelete, onDone,
}: Props) {
  const hold = (e: React.PointerEvent) => e.preventDefault();

  return (
    <div className="note-toolbar" role="toolbar" aria-label="Edit note">
      <button
        type="button" className="note-toolbar-btn" onPointerDown={hold}
        onClick={onOutdent} disabled={!canOutdent} aria-label="Outdent"
      >
        <IndentDecrease size={20} />
      </button>
      <button
        type="button" className="note-toolbar-btn" onPointerDown={hold}
        onClick={onIndent} disabled={!canIndent} aria-label="Indent"
      >
        <IndentIncrease size={20} />
      </button>
      <button
        type="button" className="note-toolbar-btn note-toolbar-btn--danger" onPointerDown={hold}
        onClick={onDelete} disabled={!canDelete} aria-label="Delete note"
      >
        <Trash2 size={19} />
      </button>
      <button
        type="button" className="note-toolbar-btn note-toolbar-done" onPointerDown={hold}
        onClick={onDone} aria-label="Done"
      >
        <Check size={20} />
      </button>
    </div>
  );
}
