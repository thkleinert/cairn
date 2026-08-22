import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { Trash2, Plus, Minus } from 'lucide-react';
import { useOutlineDrag } from '../hooks/useOutlineDrag';
import { useSwipeToDelete } from '../hooks/useSwipeToDelete';
import { toast } from '../lib/toast';
import { MentionTextarea } from './MentionTextarea';
import { NoteBody } from './NoteBody';
import {
  normaliseDepths, shiftSubtree, promotionsAfterDelete, hasChildren,
  visibleItems, siblings, MAX_DEPTH, dropSubtree, structuralDrop,
  canIndent, canOutdent, canMoveUp, canMoveDown, moveSubtree,
} from '../lib/outline';
import type { Place, TripNote } from '../types';

/** Stands in for a note id while the row being edited has no row yet. */
const DRAFT = '__draft__';

interface Draft {
  /** The note this one goes after; null appends to the end of the list. */
  afterId: string | null;
  depth: number;
}

interface Props {
  notes: TripNote[];
  places: Place[];
  onAdd: (body: string, opts: { depth: number; afterId: string | null }) => Promise<TripNote | null> | void;
  onUpdate: (id: string, body: string) => Promise<unknown> | void;
  /** Resolves false when the row did not go, so nothing is done on its behalf. */
  onRemove: (id: string) => Promise<boolean | void> | boolean | void;
  onSetDepths: (updates: { id: string; depth: number }[]) => Promise<unknown> | void;
  /** May report false when the order did not save, so a follow-up structural
   *  write can be skipped. */
  onReorder: (orderedIds: string[]) => void | boolean | Promise<void | boolean>;
  /**
   * Undo target for a swipe-delete. Without it a deletion is final.
   * Resolve false when the row did not come back, so the children promoted by
   * the delete are not pushed down under a parent that no longer exists.
   */
  onRestore?: (note: TripNote) => Promise<boolean | void> | boolean | void;
  /** Fold state, shared with the page so it survives a re-render and a reload. */
  isCollapsed?: (id: string) => boolean;
  onToggleCollapse?: (id: string) => void;
  onExpand?: (id: string) => void;
  /**
   * Flip to true to open a new bullet at the end of this list and focus it.
   * The section heading owns the affordance now, and it lives outside this
   * component, so the request has to come in as a prop rather than a button.
   */
  startDraft?: boolean;
  onDraftStarted?: () => void;
  /** Tapping an @mention jumps to that place. Omit to render mentions inert. */
  onSelectPlace?: (placeId: string) => void;
  placeholder?: string;
}

// An outline. Each bullet is its own database row, so it can be edited,
// nested, reordered and deleted on its own, and two people editing different
// bullets don't overwrite each other.
//
// Three things carry the outliner feel, in place of the buttons that used to:
//   - Enter at the end of a bullet opens the next one, already focused.
//   - Backspace at the start of an empty bullet removes it and steps back up.
//   - Swiping a row left deletes it; the toast carries the undo.
//   - Holding a bullet's dot picks it up: drag to move it, sideways to change
//     its level. That replaced an edit toolbar of six buttons, which sat
//     stacked underneath iOS's own unremovable keyboard bar.
//   - On a hardware keyboard, Tab and Shift+Tab indent and Alt+Arrow moves a
//     bullet past its sibling — the drag needs a pointer, so those are the
//     routes for anyone without one.
export function NoteList({
  notes, places, onAdd, onUpdate, onRemove, onSetDepths, onReorder, onRestore,
  isCollapsed, onToggleCollapse, onExpand, startDraft, onDraftStarted,
  onSelectPlace, placeholder = 'Add a note…',
}: Props) {
  const folded = useCallback((id: string) => isCollapsed?.(id) ?? false, [isCollapsed]);
  // Every read of depth goes through this: the stored value can describe a
  // shape no outline has, and clamping once here means nothing downstream has
  // to think about it.
  const items = useMemo(() => normaliseDepths(notes), [notes]);

  const [focusId, setFocusId] = useState<string | null>(null);
  // Mirrors focusId synchronously. blur() closes over the focusId of the
  // render that drew the textarea, so after focus has deliberately moved on it
  // cannot tell "the row I was on lost focus" from "focus already went
  // somewhere else and this is that row unmounting". The ref lets it ask.
  const focusIdRef = useRef<string | null>(null);
  focusIdRef.current = focusId;
  const [body, setBody] = useState('');
  const [draftState, setDraftState] = useState<Draft | null>(null);

  // Guards a blur that we caused ourselves by moving focus — that blur would
  // otherwise commit the row a second time, and on Enter that meant the new
  // bullet's text being written back over the one above it.
  const movingFocus = useRef(false);
  // Same window, different hazard: two Enters in quick succession would both
  // see an uncommitted draft and post it twice.
  const busy = useRef(false);
  /**
   * Latched the moment a draft's insert is issued, and only cleared when a
   * fresh draft is opened.
   *
   * `movingFocus` cannot cover this. It is lowered synchronously once a move
   * or an Enter has run, but React re-renders after the current task — so the
   * draft row unmounts, its focused textarea fires blur, and the blur handler
   * still closes over `focusId === DRAFT` from the render before. commit()
   * then inserted the same bullet a second time, which is what "shift it up
   * and it duplicates" was. A latch on the insert itself does not depend on
   * which of those two things happens first.
   */
  const draftCommitted = useRef(false);

  // No standing empty bullet, in any state. An empty list used to show one as
  // its own way in, which put a grey "Add a note…" under every place on the
  // page — mostly under places that had nothing to say. The way in is now the
  // section heading itself (see startDraft), so an empty place shows nothing
  // at all and the page reads as a list of places rather than a column of
  // prompts.
  const draft: Draft | null = draftState;

  // Every structural decision below reads `items`, never `order`.
  //
  // `order` is useDragReorder's own copy, synced from items in an effect, so
  // it lags by a render every time the list changes — and the toolbar was
  // reading it, meaning that right after a bullet was added or moved the
  // toolbar could answer "can this indent?" against the list as it was before.
  // `order` now drives the drag animation and nothing else.
  //
  // This does not fully explain a report of indent, outdent and both arrows
  // disabled at once on a list of three: the rows render from the same array,
  // so a short `order` would have rendered short too. That state has not been
  // reproduced. This is a correctness fix to a real stale read, not a
  // confirmed diagnosis of it.
  const draftIndex = useMemo(() => {
    if (!draft) return -1;
    if (draft.afterId === null) return items.length;
    const at = items.findIndex(n => n.id === draft.afterId);
    return at === -1 ? items.length : at + 1;
  }, [draft, items]);

  const focusedIndex = focusId && focusId !== DRAFT
    ? items.findIndex(n => n.id === focusId)
    : -1;


  /** The focused textarea, for putting focus back after a reorder moves it. */
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  /**
   * Run something that moves focus, or moves the row focus is in.
   *
   * Every guarded region in this file used to raise `movingFocus`, await, and
   * lower it — and each one got the edges wrong differently. Two mattered: a
   * rejection left the guard raised for the life of the component (no edit
   * ever committing again, Enter dead, nothing on screen to say why), and
   * lowering it synchronously was too early, because React re-renders after
   * the current task and the blur we are guarding against arrives then.
   *
   * So: raised here, lowered after the render has flushed, always. And if the
   * row was only moved rather than replaced, focus is put back — reordering a
   * keyed list moves the DOM node instead of remounting it, which blurs the
   * textarea without re-running autoFocus. That is the case the previous fix
   * missed: it only recognised a move that CHANGED which row was focused, and
   * Move Up on an existing bullet does not.
   */
  const withFocusMove = useCallback(async (run: () => void | Promise<void>, refocus = false) => {
    movingFocus.current = true;
    try {
      await run();
    } finally {
      requestAnimationFrame(() => {
        if (refocus) inputRef.current?.focus();
        movingFocus.current = false;
      });
    }
  }, []);

  /**
   * Remove a bullet and promote whatever was under it — the one path, used by
   * the swipe, by Backspace on an empty row, and by emptying a bullet's text.
   *
   * Emptying used to route through onUpdate straight to a delete, skipping the
   * promotion the other two were careful to do. The children kept their stored
   * depths while normaliseDepths drew them one level shallower, and the next
   * move wrote that rendered shape back — silently re-nesting them under a
   * bullet they had never been related to.
   */
  const removeBullet = useCallback(async (
    note: TripNote, index: number, opts: { offerUndo: boolean },
  ) => {
    const promotions = promotionsAfterDelete(items, index);
    const removed = await onRemove(note.id);
    if (removed === false) return false;
    if (promotions.length > 0) await onSetDepths(promotions);
    if (opts.offerUndo && onRestore) {
      toast('Note deleted', 'info', {
        label: 'Undo',
        // Sequenced, and the second write conditional on the first. Fired
        // together, a failed restore still pushed the children back down a
        // level — leaving them stored deeper than any surviving ancestor,
        // which normaliseDepths hides on screen and the next move then writes
        // back as though it were intended.
        run: () => { void (async () => {
          const back = await onRestore(note);
          if (back === false) return;
          if (promotions.length > 0) {
            await onSetDepths(promotions.map(p => ({ id: p.id, depth: p.depth + 1 })));
          }
        })(); },
      });
    }
    return true;
  }, [items, onRemove, onSetDepths, onRestore]);

  /**
   * Open a new bullet and put the caret in it. Every way of starting one goes
   * through here so the committed-latch is cleared in exactly one place —
   * forgetting it at a call site would mean a bullet that silently refuses to
   * save, which is a worse bug than the duplicate it guards against.
   */
  const openDraft = useCallback((afterId: string | null, depth: number) => {
    draftCommitted.current = false;
    setDraftState({ afterId, depth });
    setFocusId(DRAFT);
    setBody('');
  }, []);

  // Opening a bullet because the heading asked for one. Keyed on the flag
  // going true rather than on its value, so the parent can leave it set for a
  // render without reopening the draft on every re-render in between.
  useEffect(() => {
    if (!startDraft) return;
    const last = items[items.length - 1];
    // Always at the outer level, whatever the last bullet's depth happens to
    // be. The request came from the section's own heading, so it means "a new
    // note in this section" — inheriting the depth of whatever was written
    // last would tuck it under an unrelated bullet purely because that bullet
    // was nested.
    openDraft(last?.id ?? null, 0);
    onDraftStarted?.();
  }, [startDraft]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Folds that currently mean something: the id is in the fold set AND the
   * bullet still has children.
   *
   * The stored flag outlives the children it was set on. Fold a bullet, then
   * delete or outdent its last child, and the fold button disappears (nothing
   * to fold) while the flag stays set — the dot kept its ring for good, and
   * indenting the row below made it vanish on the spot, hidden under a parent
   * nobody could unfold. TripNotesPage gates its headings this way for exactly
   * the same reason; the bullets were left ungated.
   */
  const activeFolds = useMemo(() => {
    const ids = new Set<string>();
    items.forEach((n, i) => { if (folded(n.id) && hasChildren(items, i)) ids.add(n.id); });
    return ids;
  }, [items, folded]);

  /** What's actually on screen: everything not tucked under a folded bullet. */
  const visible = useMemo(
    () => visibleItems(items, id => activeFolds.has(id)),
    [items, activeFolds],
  );

  // The drag now understands subtrees, so it is no longer restricted to flat
  // lists — a bullet travels with everything nested under it, and how far it is
  // pulled sideways decides the level it lands at. That is what let the edit
  // toolbar go: indent, outdent and both arrows were four buttons doing what
  // one gesture does, and they cost a bar stacked under iOS's own.
  //
  // The drag runs in VISIBLE space — that is what the finger is over and what
  // the gap animation measures — while the outline it edits is `items`. The two
  // differ the moment anything is folded, so the drop translates between them
  // rather than assuming they line up: the row the block came to rest above is
  // looked up by id, and its position in the structural list is where the block
  // is actually inserted. Dropping "before the next visible row" also gives the
  // right answer for a folded bullet for free — you cannot land inside
  // something whose children are not on screen.
  const handleDrop = useCallback(async (rootId: string, vTarget: number, depth: number) => {
    const where = structuralDrop(items, visible, rootId, vTarget);
    if (!where) return;
    const { index, targetIndex } = where;

    const landed = dropSubtree(items, index, targetIndex, depth);
    if (!landed) return;

    // Open a folded new parent BEFORE the write, exactly as nudge does for the
    // indent key. Otherwise the bullet lands inside something closed and
    // disappears the instant it arrives, with no toast and nothing to undo —
    // the drag replaced those buttons, so it inherits the hazard they were
    // fixed for. The parent is the nearest row above it that is shallower.
    const at = landed.findIndex(n => n.id === rootId);
    for (let i = at - 1; i >= 0; i--) {
      if (landed[i].depth < landed[at].depth) {
        if (folded(landed[i].id)) onExpand?.(landed[i].id);
        break;
      }
    }

    // Order first, and awaited. It is optimistic, so waiting on the write
    // behind it costs the eye nothing — and the two CAN half-apply: they touch
    // different columns, so neither refetch undoes the other, but a failed
    // reorder followed by a successful depth write leaves the server's old
    // order carrying the new depths, and the bullet renders as a child of
    // whatever happens to precede it.
    const before = items.map(n => n.id).join(',');
    const after = landed.map(n => n.id).join(',');
    if (after !== before) {
      const ok = await onReorder(landed.map(n => n.id));
      if (ok === false) return;
    }

    const byId = new Map(items.map(n => [n.id, n.depth]));
    const moved = landed.filter(n => byId.get(n.id) !== n.depth);
    if (moved.length) void onSetDepths(moved);
  }, [items, visible, onReorder, onSetDepths, folded, onExpand]);

  const { dragId, depth: dragDepth, settling, onPointerDown: handlePointerDown,
          onPointerMove: handlePointerMove, onPointerUp: handlePointerUp,
          onClickCapture: handleClickCapture, onPointerCancel: handlePointerCancel,
          offsetFor, inBlock } =
    useOutlineDrag({
      // Visible rows, because the geometry and the level preview both belong to
      // what is on screen. handleDrop maps back to the outline.
      items: visible,
      blockLength: (vIndex) => {
        const d = visible[vIndex]?.depth ?? 0;
        let n = 1;
        while (vIndex + n < visible.length && visible[vIndex + n].depth > d) n += 1;
        return n;
      },
      onDrop: (id, target, depth) => { void handleDrop(id, target, depth); },
      // Never while a bullet is being edited: the finger is there to type.
      enabled: !focusId && items.length > 1,
    });


  /** Where the draft row goes among the visible ones. */
  const draftVisibleIndex = useMemo(() => {
    if (!draft) return -1;
    if (draft.afterId === null) return visible.length;
    const at = visible.findIndex(n => n.id === draft.afterId);
    return at === -1 ? visible.length : at + 1;
  }, [draft, visible]);

  /** Depth the row above the draft allows it to reach. */
  const draftMaxDepth = useMemo(() => {
    if (draftIndex <= 0) return 0;
    const above = items[draftIndex - 1];
    return above ? Math.min(above.depth + 1, MAX_DEPTH) : 0;
  }, [draftIndex, items]);

  const commit = useCallback(async (): Promise<TripNote | null> => {
    const id = focusId;
    if (!id) return null;
    if (id === DRAFT) {
      const trimmed = body.trim();
      if (!trimmed || !draft) return null;
      // Latch before awaiting, not after: the insert is in flight for a whole
      // round trip, and a blur arriving during it must find the door shut.
      if (draftCommitted.current) return null;
      draftCommitted.current = true;
      try {
        const created = await onAdd(trimmed, { depth: draft.depth, afterId: draft.afterId }) ?? null;
        // …and lift again if nothing was written. The latch exists to stop the
        // same bullet being inserted twice, not to stop it being inserted at
        // all: left raised after a failed insert it made every later attempt a
        // silent no-op, so the row sat there with its text and then vanished
        // when the user tapped away, having shown one toast minutes earlier.
        if (created === null) draftCommitted.current = false;
        return created;
      } catch {
        // A rejection is a write that did not happen, same as a null — and it
        // has to clear the latch by the same reasoning. It arrives by a
        // different door: addNote awaits supabase.auth.getUser(), which
        // REJECTS on a dead network rather than returning an error, so nothing
        // downstream has reported it either.
        draftCommitted.current = false;
        toast('Could not add note');
        return null;
      }
    }
    const at = items.findIndex(n => n.id === id);
    const note = at === -1 ? undefined : items[at];
    if (!note) return null;
    // An emptied bullet deletes itself, through removeBullet like every other
    // deletion, so its children are promoted. Routing a blank body to onUpdate
    // reached the same delete without them.
    if (!body.trim()) {
      await removeBullet(note, at, { offerUndo: true });
      return null;
    }
    if (body.trim() !== note.body) await onUpdate(id, body);
    return note;
  }, [focusId, body, draft, items, onAdd, onUpdate, removeBullet]);

  const startEdit = useCallback(async (note: TripNote) => {
    if (focusId === note.id) return;
    movingFocus.current = true;
    try {
      await commit();
      setDraftState(null);
      setFocusId(note.id);
      setBody(note.body);
    } finally {
      // In a finally, not after the await. These guards suppress blur and
      // Enter while focus is deliberately moving; left raised by a rejected
      // promise they stay raised for the life of the component — no edit ever
      // commits again and Enter stops responding, with nothing on screen to
      // say why. addNote awaits supabase.auth.getUser(), which REJECTS rather
      // than returning an error when the network is down.
      movingFocus.current = false;
    }
  }, [commit, focusId]);

  /**
   * `from` is the row the textarea was rendered for. If focus has since moved
   * elsewhere, this blur is that row unmounting behind a move we made — and
   * clearing state here would undo it.
   *
   * movingFocus alone could not cover this: it is lowered synchronously when a
   * move finishes, but React re-renders after the current task, so the unmount
   * blur always arrived after the guard was already down. Tapping Move Up on a
   * bullet you were typing therefore dismissed the keyboard instead of staying
   * on the moved bullet.
   */
  const blur = useCallback(async (from: string | null) => {
    if (movingFocus.current) return;
    if (from !== null && focusIdRef.current !== from) return;
    const saved = await commit();
    // Checked AGAIN, because commit() awaits a network write and the world
    // moves during it: tapping another bullet fires this blur first, then
    // opens that bullet, and this resolving afterwards would tear down the
    // editor that is now open — the keyboard dropping a beat after the user
    // tapped somewhere else.
    if (movingFocus.current) return;
    if (from !== null && focusIdRef.current !== from) return;
    // A draft whose insert failed keeps its text and its row. Clearing here
    // would throw away what was typed with nothing but a toast to show for it.
    if (from === DRAFT && saved === null && body.trim()) return;
    setFocusId(null);
    setDraftState(null);
    setBody('');
  }, [commit, body]);

  /**
   * Backspace at the very start of an empty bullet removes it and puts the
   * caret at the end of the one above — how every outliner walks back up a
   * list. Only when it's empty: at the start of a bullet with text it would
   * eat the previous bullet's content.
   */
  const handleBackspaceAtStart = useCallback(async () => {
    const id = focusId;
    if (!id || body.length > 0) return false;

    // The bullet above ON SCREEN, not the one above in the outline. With a
    // folded bullet between them the outline's predecessor is hidden, and
    // focusing it left the keyboard up and the toolbar acting on a row that
    // renders nowhere.
    // A draft can be anchored to a bullet that is not on screen — the
    // startDraft effect anchors to the last item in the outline, which may be
    // a collapsed bullet's child. Falling back to the last visible row keeps
    // Backspace stepping up instead of dismissing the keyboard.
    const visibleAt = visible.findIndex(n => n.id === (id === DRAFT ? draft?.afterId : id));
    const previous = id === DRAFT
      ? (visibleAt === -1 ? visible[visible.length - 1] : visible[visibleAt])
      : (visibleAt === -1 ? undefined : visible[visibleAt - 1]);

    if (id === DRAFT) {
      if (draft && draft.depth > 0) { setDraftState({ ...draft, depth: draft.depth - 1 }); return true; }
      await withFocusMove(() => {
        setDraftState(null);
        if (previous) { setFocusId(previous.id); setBody(previous.body); }
        else { setFocusId(null); setBody(''); }
      });
      return true;
    }

    // An empty row has nothing to restore, so no Undo is offered for it.
    await withFocusMove(async () => {
      const note = items[focusedIndex];
      if (note) await removeBullet(note, focusedIndex, { offerUndo: false });
      if (previous) { setFocusId(previous.id); setBody(previous.body); }
      else { setFocusId(null); setBody(''); }
    });
    return true;
  }, [focusId, body, focusedIndex, draft, items, visible, removeBullet, withFocusMove]);

  /** Enter: close this bullet and open the next one at the same level. */
  const handleEnter = useCallback(async () => {
    if (busy.current) return;
    const id = focusId;
    if (!id) return;

    if (id === DRAFT) {
      if (!draft) return;
      if (!body.trim()) {
        // Enter on an empty bullet steps back out a level, and at the outer
        // edge closes the list — the standard way to end an outline.
        if (draft.depth > 0) setDraftState({ ...draft, depth: draft.depth - 1 });
        else await blur(DRAFT);
        return;
      }
      busy.current = true;
      movingFocus.current = true;
      try {
        const created = await commit();
        // Nothing was written — keep the bullet, its text and the caret where
        // they are so it can simply be tried again. Opening the next bullet
        // here would discard what was typed on the strength of a toast.
        if (!created) return;
        openDraft(created.id, draft.depth);
      } finally {
        movingFocus.current = false;
        busy.current = false;
      }
      return;
    }

    // Emptied: this is a deletion, not a new bullet. Committing first would
    // delete the row and then anchor the new draft to its dead id, which sent
    // the bullet to the bottom of the list.
    //
    // Removed here rather than delegated to handleBackspaceAtStart, whose own
    // guard is `body.length > 0` — a body of spaces is empty by one test and
    // not by the other, so Enter on it did nothing whatsoever and the key had
    // already been swallowed.
    if (!body.trim()) {
      const at = items.findIndex(n => n.id === id);
      const note = at === -1 ? undefined : items[at];
      const above = at > 0 ? visible[visible.findIndex(n => n.id === id) - 1] : undefined;
      await withFocusMove(async () => {
        if (note) await removeBullet(note, at, { offerUndo: false });
        if (above) { setFocusId(above.id); setBody(above.body); }
        else { setFocusId(null); setBody(''); }
      });
      return;
    }

    busy.current = true;
    movingFocus.current = true;
    try {
    const at = items.findIndex(n => n.id === id);
    const note = items[at];
    // The new bullet is inserted directly after this one, which is inside its
    // folded subtree — so unfold first, or you would be typing into a row that
    // isn't on screen.
    if (folded(id)) onExpand?.(id);
    await commit();
    // A bullet with children takes the new one as its FIRST CHILD, not as a
    // sibling. A sibling is inserted directly after this row and therefore
    // *above* the children, and since the tree is implied by depth those
    // children would silently re-parent themselves under the empty bullet that
    // just appeared — pressing Enter on a heading would steal everything under
    // it. Every outliner does it this way for the same reason.
    const nests = at !== -1 && hasChildren(items, at);
    openDraft(id, Math.min((note?.depth ?? 0) + (nests ? 1 : 0), MAX_DEPTH));
    } finally {
      movingFocus.current = false;
      busy.current = false;
    }
  }, [focusId, draft, body, commit, blur, items, visible, folded, onExpand, openDraft, removeBullet, withFocusMove]);

  const deleteNote = useCallback(async (note: TripNote, index: number) => {
    let removed = false;
    // The guard goes up around the REMOVAL, not after it. removeNote drops the
    // row from state synchronously before its own await, so the <li> unmounts
    // inside this same click and fires blur while the guard is still down —
    // and blur then commits against a note that no longer exists. Deleting a
    // bullet whose text had been edited produced a spurious "Could not save
    // note"; deleting one whose text had been cleared ran the whole deletion a
    // second time, for a second Undo toast on an already-gone row and a second
    // promotion pass over its children.
    await withFocusMove(async () => {
      removed = await removeBullet(note, index, { offerUndo: true });
      // Torn down only once the row has actually gone. Clearing first meant an
      // offline delete took the keyboard, the toolbar and the caret away and
      // then left the bullet sitting there with a toast saying it had failed.
      if (removed && focusIdRef.current === note.id) { setFocusId(null); setBody(''); }
    });
    return removed;
  }, [removeBullet, withFocusMove]);

  // ---- toolbar ----------------------------------------------------------

  /**
   * Move the focused bullet past its sibling, children in tow — the keyboard's
   * replacement for the toolbar's up and down arrows.
   *
   * Alt+Arrow, because the bare arrows belong to the caret. Without it the drag
   * is the only route to reordering and the drag needs a pointer, so a
   * keyboard-only user could create, edit and delete bullets but never move
   * one.
   */
  const moveFocused = useCallback((direction: 1 | -1) => {
    if (focusId === DRAFT || focusedIndex === -1) return;
    if (direction === -1 ? !canMoveUp(items, focusedIndex) : !canMoveDown(items, focusedIndex)) return;
    const next = moveSubtree(items, focusedIndex, direction);
    if (next) void onReorder(next);
  }, [focusId, focusedIndex, items, onReorder]);

  const nudge = useCallback((delta: 1 | -1) => {
    if (focusId === DRAFT) {
      if (draft) setDraftState({ ...draft, depth: Math.max(0, Math.min(draft.depth + delta, draftMaxDepth)) });
      return;
    }
    if (focusedIndex === -1) return;
    // The toolbar supplied this guard by disabling its buttons. Without it Tab
    // wrote a depth one past what the outline allows: normaliseDepths clamps on
    // the way back out, so the screen looked right while the stored value was
    // wrong — and the next edit to the bullet above silently pulled this one
    // down to the illegal depth it had been carrying all along.
    if (delta === 1 ? !canIndent(items, focusedIndex) : !canOutdent(items, focusedIndex)) return;
    // Indenting makes this bullet a child of the one above. If that one is
    // carrying a fold flag from an earlier life — folded once, then emptied,
    // so the flag survived with no control left to clear it — the new child
    // would be hidden the instant it arrives, while the toolbar still points
    // at it. Gating the flag on having children is not enough on its own,
    // because this is the moment it gets children back.
    if (delta === 1) {
      // The row it becomes a child of is its previous SIBLING, which is not
      // the row immediately above once anything in between is nested — with
      // A(0), B(1), C(0), indenting C makes it a child of A, not of B.
      const { prev } = siblings(items, focusedIndex);
      if (prev !== -1 && folded(items[prev].id)) onExpand?.(items[prev].id);
    }
    void onSetDepths(shiftSubtree(items, focusedIndex, delta));
  }, [focusId, draft, draftMaxDepth, focusedIndex, items, onSetDepths, folded, onExpand]);

  // ---- render -----------------------------------------------------------

  const renderEditor = (ariaLabel: string, autoFocus: boolean) => (
    <MentionTextarea
      value={body}
      onChange={setBody}
      onSubmit={handleEnter}
      onBlur={() => blur(focusId)}
      onBackspaceAtStart={handleBackspaceAtStart}
      onIndent={nudge}
      onMoveBullet={moveFocused}
      atOuterLevel={focusId === DRAFT
        ? (draft?.depth ?? 0) === 0
        : focusedIndex === -1 || !canOutdent(items, focusedIndex)}
      onCancel={() => { movingFocus.current = true; setFocusId(null); setDraftState(null); setBody(''); movingFocus.current = false; }}
      places={places}
      autoFocus={autoFocus}
      ariaLabel={ariaLabel}
      className="note-bullet-input"
      inputRef={inputRef}
      placeholder={focusId === DRAFT && items.length === 0 ? placeholder : undefined}
    />
  );

  const draftRow = draft && (
    <li
      key="draft"
      className="note-bullet note-bullet--draft"
      style={{ '--note-depth': draft.depth } as React.CSSProperties}
    >
      <div className="note-bullet-slide">
        <span className="note-bullet-dot" aria-hidden="true" />
        {focusId === DRAFT ? (
          renderEditor('New note', true)
        ) : (
          <span
            className="note-bullet-body note-bullet-body--placeholder"
            role="button"
            tabIndex={0}
            onClick={() => { draftCommitted.current = false; setFocusId(DRAFT); setBody(''); }}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault(); draftCommitted.current = false; setFocusId(DRAFT); setBody('');
              }
            }}
          >
            {placeholder}
          </span>
        )}
      </div>
    </li>
  );

  // Two index spaces, and they stop agreeing the moment anything is folded:
  // `visible` is what is on screen and what the drag measures, `items` is the
  // outline every structural decision is made against. Rows are keyed by
  // position in `visible`; handleDrop translates back.
  const itemIndexOf = useMemo(() => new Map(items.map((n, i) => [n.id, i])), [items]);
  const canDrag = !focusId && items.length > 1;

  // Where the block being dragged starts, so its descendants can be shifted by
  // the same delta the root picked up.
  const dragRootIndex = dragId === null ? -1 : visible.findIndex(n => n.id === dragId);

  const rows = visible.map((note, vIndex) => {
    const structural = itemIndexOf.get(note.id) ?? -1;
    // A block in flight renders at the level it would LAND at, not the one it
    // came from — that is the whole feedback for the sideways half of the
    // gesture. Nothing double-counts: the block is translated vertically only,
    // so the indent is free to show the answer. Descendants shift by the same
    // delta, so the subtree keeps its shape while it moves.
    const dragging = inBlock(vIndex);
    const shown = dragging
      ? Math.max(0, note.depth + (dragDepth - (visible[dragRootIndex]?.depth ?? note.depth)))
      : note.depth;
    return (
      <NoteRow
        key={note.id}
        note={note}
        depth={shown}
        index={vIndex}
        places={places}
        editing={focusId === note.id}
        dragging={dragging}
        offsetPx={offsetFor(vIndex)}
        suppressTransition={settling}
        canDrag={canDrag}
        collapsible={structural !== -1 && hasChildren(items, structural)}
        collapsed={activeFolds.has(note.id)}
        onToggleCollapse={onToggleCollapse ? () => onToggleCollapse(note.id) : undefined}
        onStartEdit={() => void startEdit(note)}
        onDelete={() => structural === -1 ? false : deleteNote(note, structural)}
        onSelectPlace={onSelectPlace}
        onGripDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onClickCapture={handleClickCapture}
        renderEditor={renderEditor}
      />
    );
  });

  if (draftRow) rows.splice(draftVisibleIndex, 0, draftRow);

  return (
    <div className="note-list">
      <ul className="note-bullets">{rows}</ul>

    </div>
  );
}

// ---------------------------------------------------------------------------

interface RowProps {
  note: TripNote;
  /** The level to RENDER at — the landing level while this row is being
   *  dragged, its own the rest of the time. */
  depth: number;
  index: number;
  places: Place[];
  editing: boolean;
  dragging: boolean;
  offsetPx: number;
  suppressTransition: boolean;
  canDrag: boolean;
  collapsible: boolean;
  collapsed: boolean;
  onToggleCollapse?: () => void;
  onStartEdit: () => void;
  /** False when the row survived, so the swipe can put it back. */
  onDelete: () => void | boolean | Promise<void | boolean>;
  onSelectPlace?: (placeId: string) => void;
  onGripDown: (index: number, row: HTMLElement, e: React.PointerEvent, cancelSwipe?: () => void) => void;
  onPointerMove?: (e: React.PointerEvent) => void;
  onPointerUp?: (e: React.PointerEvent) => void;
  onPointerCancel?: (e: React.PointerEvent) => void;
  onClickCapture?: (e: React.MouseEvent) => void;
  renderEditor: (ariaLabel: string, autoFocus: boolean) => React.ReactNode;
}

// Its own component so each row owns a swipe hook. Hooks can't be called in a
// loop, and a single shared swipe state would move every row at once.
function NoteRow({
  note, depth, index, places, editing, dragging, offsetPx, suppressTransition, canDrag,
  collapsible, collapsed, onToggleCollapse,
  onStartEdit, onDelete, onSelectPlace, onGripDown, onPointerMove, onPointerUp,
  onPointerCancel, onClickCapture, renderEditor,
}: RowProps) {
  const swipe = useSwipeToDelete({ onDelete, enabled: !editing && !dragging });
  const cancelSwipe = swipe.cancel;


  return (
    <li
      className={`note-bullet ${dragging ? 'note-bullet--dragging' : ''} ${swipe.swiping ? 'note-bullet--swiping' : ''}`}
      style={{
        '--note-depth': depth,
        transform: dragging ? undefined : `translateY(${offsetPx}px)`,
        transition: suppressTransition ? 'none' : undefined,
      } as React.CSSProperties}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClickCapture={onClickCapture}
    >
      {/* Revealed by the row sliding off it, so the gesture explains itself
          before it completes. */}
      <span className={`note-bullet-trail ${swipe.armed ? 'note-bullet-trail--armed' : ''}`} aria-hidden="true">
        <Trash2 size={16} />
      </span>

      {/* Swipe handlers only while NOT editing.

          Attaching them during an edit was an attempt to keep delete reachable
          for a bullet you were typing in, once the toolbar's trash had gone.
          It backfired: the textarea lives inside this element, so dragging left
          to SELECT A WORD engaged the swipe, captured the pointer away from the
          field, blurred it and deleted the note on release — leftward only,
          which made it look random. Excluding just the textarea fixed that but
          left the remaining path (a swipe from the dot) not deleting for a
          second reason I could not account for, and an unexplained delete path
          is worse than a missing one.

          So: finish the edit, then swipe. iOS's own keyboard bar carries Done,
          Escape works on a hardware keyboard, and an empty bullet still
          disappears on Backspace. */}
      <div className="note-bullet-slide" style={swipe.style} {...(editing ? {} : swipe.handlers)}>
        {/* The dot is the drag handle, as in any outliner — no separate grip
            column, which is what let the row shed its buttons entirely. A
            folded bullet's dot gains a ring, so a section with something
            hidden under it reads as closed even out of the corner of an eye. */}
        <span
          className={`note-bullet-dot ${canDrag ? 'note-bullet-dot--draggable' : ''} ${collapsed ? 'note-bullet-dot--folded' : ''}`}
          aria-hidden="true"
          onPointerDown={canDrag
            ? e => {
                // NOT stopped, deliberately. The swipe lives on
                // .note-bullet-slide, which this dot sits inside, and swallowing
                // the press here meant a left swipe that happened to start on
                // the dot — which is exactly where a thumb starts one — could
                // never become a delete. Both gestures now see the press; the
                // hold decides, and the drag cancels the swipe if it wins.
                onGripDown(
                  index,
                  e.currentTarget.parentElement?.parentElement as HTMLElement,
                  e,
                  cancelSwipe,
                );
              }
            : undefined}
        />

        {editing ? renderEditor('Edit note', true) : (
          <span
            className="note-bullet-body"
            role="button"
            tabIndex={0}
            onClick={onStartEdit}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onStartEdit(); }
            }}
          >
            <NoteBody body={note.body} places={places} onSelectPlace={onSelectPlace} />
          </span>
        )}

        {/* Fold control on the right edge, as in Dynalist. The left of the row
            is spoken for — the dot drags, the text edits — and the right is
            the only part of a bullet that isn't already a target. Hidden while
            editing so it can't be hit by a thumb reaching for the keyboard. */}
        {collapsible && !editing && onToggleCollapse && (
          <button
            type="button"
            className="note-fold"
            aria-label={collapsed ? 'Expand' : 'Collapse'}
            aria-expanded={!collapsed}
            onClick={e => { e.stopPropagation(); onToggleCollapse(); }}
            onPointerDown={e => e.stopPropagation()}
          >
            {collapsed ? <Plus size={15} /> : <Minus size={15} />}
          </button>
        )}
      </div>
    </li>
  );
}
