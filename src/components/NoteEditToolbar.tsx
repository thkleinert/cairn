import { IndentDecrease, IndentIncrease, ArrowUp, ArrowDown, Trash2, Check } from 'lucide-react';

interface Props {
  canIndent: boolean;
  canOutdent: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canDelete: boolean;
  onIndent: () => void;
  onOutdent: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onDone: () => void;
}

// The bar that sits on top of the keyboard while a bullet is being edited —
// where indent, outdent, move and delete live, since a phone keyboard has no
// Tab key and the rows themselves carry no buttons any more.
//
// Anchored with --keyboard-inset (see viewport.js) rather than to the focused
// row: on iOS the layout viewport does not shrink for the keyboard, so a bar
// positioned any other way sits underneath it. On iOS the inset also covers
// the system's own form accessory bar, which a web page cannot suppress, so
// this lands above that rather than behind it.
//
// Deliberately monochrome, including delete. A single red control in a bar of
// grey ones pulls the eye to it every time the keyboard opens, which is the
// opposite of what a destructive action wants — the confirmation for deleting
// is the Undo on the toast, not a colour warning up front.
//
// Every button suppresses pointerdown. A button that takes focus dismisses the
// keyboard and blurs the textarea, which commits the edit and unmounts this
// bar — so the tap would land on nothing and the action would never run.
export function NoteEditToolbar({
  canIndent, canOutdent, canMoveUp, canMoveDown, canDelete,
  onIndent, onOutdent, onMoveUp, onMoveDown, onDelete, onDone,
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
        type="button" className="note-toolbar-btn" onPointerDown={hold}
        onClick={onMoveUp} disabled={!canMoveUp} aria-label="Move up"
      >
        <ArrowUp size={20} />
      </button>
      <button
        type="button" className="note-toolbar-btn" onPointerDown={hold}
        onClick={onMoveDown} disabled={!canMoveDown} aria-label="Move down"
      >
        <ArrowDown size={20} />
      </button>
      <button
        type="button" className="note-toolbar-btn" onPointerDown={hold}
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
