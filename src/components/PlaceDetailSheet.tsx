import { useState, useEffect, useRef } from 'react';
import { useSwipeToClose } from '../hooks/useSwipeToClose';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { useComments } from '../hooks/useComments';
import { ImageLightbox } from './ImageLightbox';
import { QuickAddSheet } from './QuickAddSheet';
import { TagPickerSheet } from './TagPickerSheet';
import { NoteList } from './NoteList';
import { NoteBody } from './NoteBody';
import { DateRangeField } from './DateRangeField';
import { DateRangeSheet, type DateRange } from './DateRangeSheet';
import { normaliseDepths } from '../lib/outline';
import { visitsForPlace, baseYear } from '../lib/timeline';
import {
  X,
  Trash2, Save, MapPin, Plus, SendHorizontal, ChevronRight
} from 'lucide-react';
import type { Place, Tag, PlaceImage, TripNote, PlaceVisit } from '../types';
import { format, formatDistanceToNow } from 'date-fns';
import { authorName, avatarColor } from '../lib/people';

// Check that draws itself when the parent gains .visited-icon-btn--visited
function CheckRing() {
  return (
    <svg className="check-ring" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <circle className="check-ring-circle" cx="10" cy="10" r="8.5" fill="none" strokeWidth="1.5" />
      <path className="check-ring-path" d="M6 10.2l2.6 2.6L14 7.4" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface Props {
  place: Place;
  allTags: Tag[];
  onClose: () => void;
  onToggleVisited: () => void;
  onDelete: () => void;
  onSetTags: (tagIds: string[]) => void;
  /** Anchor this place inside another, or release it with null. */
  onSetParent?: (parentId: string | null) => void;
  onAddImage: (url: string, caption?: string) => Promise<PlaceImage | null>;
  onUploadImage?: (file: File) => Promise<PlaceImage | null>;
  onRemoveImage: (imageId: string) => void;
  // Bullets for this place. Absent on the read-only shared view, which gets a
  // flattened copy on the place itself instead.
  notes?: TripNote[];
  allPlaces?: Place[];
  onAddNote?: (body: string, opts: { depth: number; afterId: string | null }) => Promise<TripNote | null> | void;
  onUpdateNote?: (id: string, body: string) => Promise<unknown> | void;
  onRemoveNote?: (id: string) => Promise<boolean | void> | boolean | void;
  onRestoreNote?: (note: TripNote) => Promise<boolean | void> | boolean | void;
  onSetNoteDepths?: (updates: { id: string; depth: number }[]) => Promise<unknown> | void;
  onReorderNotes?: (orderedIds: string[]) => void | boolean | Promise<void | boolean>;
  onCreateTag?: (name: string, color: string, icon?: string) => Promise<Tag | null>;
  // When this place is. Every visit in the trip, not just this place's — the
  // filtering happens here so the caller cannot hand over a list grouped by a
  // rule this sheet disagrees with.
  visits?: PlaceVisit[];
  onAddVisit?: (startsOn: string, endsOn: string | null) => Promise<PlaceVisit | null>;
  onUpdateVisit?: (id: string, updates: { starts_on?: string; ends_on?: string | null }) => Promise<boolean>;
  onRemoveVisit?: (id: string) => Promise<boolean>;
  readOnly?: boolean;
  // When opened from a comment notification, expand + scroll to the thread.
  scrollToComments?: boolean;
  onCommentsShown?: () => void;
}

export function PlaceDetailSheet({
  place, allTags, onClose, onToggleVisited, onDelete, onSetParent,
  onSetTags, onAddImage, onUploadImage, onRemoveImage, onCreateTag, readOnly = false,
  visits = [], onAddVisit, onUpdateVisit, onRemoveVisit,
  scrollToComments = false, onCommentsShown,
  notes = [], allPlaces = [], onAddNote, onUpdateNote, onRemoveNote, onRestoreNote,
  onSetNoteDepths, onReorderNotes,
}: Props) {
  const [selectedTags, setSelectedTags] = useState<string[]>((place.tags ?? []).map(t => t.id));
  const [dirty, setDirty] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [showAddPhotos, setShowAddPhotos] = useState(false);
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [addingNote, setAddingNote] = useState(false);
  // Whether the calendar is open for a NEW visit. Existing ones carry their
  // own open state inside their field.
  const [addingVisit, setAddingVisit] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');
  const [commentsOpen, setCommentsOpen] = useState(true);
  const galleryRef = useRef<HTMLDivElement>(null);
  const discussionRef = useRef<HTMLDivElement>(null);

  const { comments, currentUserId, loading: commentsLoading, error: commentsError, reload: reloadComments, addComment, deleteComment } = useComments(place.id);

  // Only a top-level stop can hold anything, and a place cannot hold itself.
  const parentOptions = allPlaces.filter(
    p => p.id !== place.id && p.kind === 'stop' && !p.parent_place_id,
  );
  // A place holding spots cannot be moved into one — it would have to
  // become a spot while still holding them, which setPlaceParent refuses.
  const hasChildren = allPlaces.some(p => p.parent_place_id === place.id);
  // A spot whose stop was deleted while the follow-up write was in flight,
  // or one a collaborator orphaned. It behaves as top-level everywhere that
  // reads the tree, but its `kind` still says otherwise, which quietly bars it
  // from being a parent and from the map's Spots filter. The select cannot
  // repair it — its value already matches "Nowhere in particular", so choosing
  // that fires no change — so this is the one control that can.
  const isOrphanSpot = place.kind === 'spot' && !place.parent_place_id;

  // This place's dates, earliest first. Only a stop can have any — a spot is
  // inside a stop and inherits its window by sitting there — so the section
  // below is not offered for anything else, and the database refuses it in
  // case something offers it anyway.
  const placeVisits = visitsForPlace(visits, place.id);
  const canEditVisits = !readOnly && place.kind === 'stop' && !!onAddVisit;
  // Filing a dated stop inside another stop would make it a spot, which
  // places_dated_stop_guard refuses. Pre-empted here rather than left to fail:
  // the reason is a section further up this same sheet, and a select that
  // silently rejects every option is worse than one that says why. The write
  // still surfaces the guard's own message if a collaborator dates this place
  // while the sheet is open.
  const blockedByDates = place.kind === 'stop' && placeVisits.length > 0;

  const handleAddComment = async () => {
    const body = commentDraft.trim();
    if (!body) return;
    // Clear eagerly for snappy UX, but put the text back if the post fails so
    // a flaky connection doesn't eat the comment.
    setCommentDraft('');
    const ok = await addComment(body);
    if (!ok) setCommentDraft(body);
  };

  // Arriving from a comment notification: make sure the thread is expanded,
  // then scroll it into view once it has rendered. Waits out the sheet's
  // slide-up (0.45s) — scrolling a still-animating, transformed container
  // doesn't take. Instant scroll (not smooth): a smooth scroll kicked off
  // as the sheet settles gets dropped. Fires once per open.
  useEffect(() => {
    if (!scrollToComments || commentsLoading) return;
    setCommentsOpen(true);
    const t = setTimeout(() => {
      discussionRef.current?.scrollIntoView({ block: 'start' });
      onCommentsShown?.();
    }, 500);
    return () => clearTimeout(t);
  }, [scrollToComments, commentsLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setSelectedTags((place.tags ?? []).map(t => t.id));
    setDirty(false);
    // The sheet is reused rather than remounted when another place is opened,
    // so a calendar left open would follow you to the next one.
    setAddingVisit(false);
  }, [place.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Add a visit, from a range chosen in one go.
   *
   * This used to be forty lines coordinating two date inputs with an insert
   * that might still be in flight — a re-entry flag, a held-over value, and a
   * follow-up write to apply whatever changed while the row was being created.
   * All of it existed because two fields could each fire a change at any
   * moment, including during the write. A range arrives complete or not at
   * all, so there is one call and nothing to reconcile.
   */
  const handleAddVisit = async (range: DateRange | null): Promise<boolean> => {
    if (!range || !onAddVisit) return false;
    // Reported, not swallowed. The calendar keeps itself open on false, so a
    // failed insert leaves the dates on screen to retry from rather than a
    // toast and an unchanged section — which is the guarantee the two-input
    // editor had and this briefly lost.
    return !!(await onAddVisit(range.start, range.end));
  };

  const images: PlaceImage[] = place.images ?? [];
  // get_shared_trip flattens a place's bullets onto the place itself, since the
  // anonymous view has no trip-notes subscription of its own.
  const sharedNotes = readOnly ? (place.note_items ?? []) : notes;
  const assignedTags = allTags.filter(t => selectedTags.includes(t.id));

  // Notes are no longer part of this draft — each bullet saves itself the
  // moment it's committed, so only the tag selection needs flushing here.
  const handleSave = () => {
    onSetTags(selectedTags);
    setDirty(false);
  };

  // Never silently discard edits — flush unsaved changes on any close path
  const handleClose = () => {
    if (dirty && !readOnly) handleSave();
    onClose();
  };

  useEscapeClose(handleClose);

  const toggleTag = (id: string) => {
    if (readOnly) return;
    setSelectedTags(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id]);
    setDirty(true);
  };

  const scrollGalleryToEnd = () => {
    setTimeout(() => {
      if (galleryRef.current) galleryRef.current.scrollLeft = galleryRef.current.scrollWidth;
    }, 100);
  };

  const handleAddImageUrl = async (url: string) => {
    await onAddImage(url);
    scrollGalleryToEnd();
  };

  const handleUploadImages = async (files: FileList) => {
    if (!onUploadImage) return;
    for (const file of Array.from(files)) {
      await onUploadImage(file);
    }
    scrollGalleryToEnd();
  };

  const isVisited = place.status === 'visited';

  const visitedToggle = readOnly ? (
    <div className={`visited-icon-btn ${isVisited ? 'visited-icon-btn--visited' : ''}`} role="status" aria-label={isVisited ? 'Visited' : 'Planned'}>
      <CheckRing />
    </div>
  ) : (
    <button
      className={`visited-icon-btn ${isVisited ? 'visited-icon-btn--visited' : ''}`}
      onClick={onToggleVisited}
      aria-label={isVisited ? 'Mark as not visited' : 'Mark as visited'}
    >
      <CheckRing />
    </button>
  );

  const { sheetRef, handleProps } = useSwipeToClose(handleClose);

  return (
    <div className="bottom-sheet-overlay" onClick={handleClose}>
      <div
        className="bottom-sheet place-detail-sheet"
        ref={sheetRef}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={place.name}
      >
        <div className="bottom-sheet-handle" {...handleProps} />

        {/* Cover photo — auto-pulled from Google at creation time, not
            part of the manually-curated gallery below */}
        {place.image_url ? (
          <div className="place-image-wrap">
            <img src={place.image_url} alt={place.name} className="place-image" onError={() => {}} />
            <button className="sheet-close" onClick={handleClose} aria-label="Close"><X size={20} /></button>
          </div>
        ) : (
          <div className="sheet-header-row">
            <h2 className="place-name">{place.name}</h2>
            {visitedToggle}
            <button className="sheet-close" onClick={handleClose} aria-label="Close"><X size={20} /></button>
          </div>
        )}

        {place.image_url && (
          <div className="place-name-row">
            <h2 className="place-name">{place.name}</h2>
            {visitedToggle}
          </div>
        )}

        {place.address && (
          <p className="place-address"><MapPin size={13} /> {place.address}</p>
        )}
        {isVisited && place.visited_at && (
          <p className="visited-date-line">Visited · {format(new Date(place.visited_at), 'MMM d, yyyy')}</p>
        )}

        {/* Tags — only the ones already on this place; the + opens the
            full trip tag list to add more or create a new one */}
        {(assignedTags.length > 0 || !readOnly) && (
          <div className="detail-section">
            <label className="detail-label">Tags</label>
            <div className="tag-chips">
              {assignedTags.map(tag => (
                <button
                  key={tag.id}
                  className="tag-chip tag-chip--active"
                  style={{ '--tag-color': tag.color } as React.CSSProperties}
                  onClick={() => toggleTag(tag.id)}
                  disabled={readOnly}
                >
                  {tag.icon
                    ? <span>{tag.icon}</span>
                    : <span className="tag-chip-dot" style={{ background: tag.color }} />}
                  {tag.name}
                </button>
              ))}
              {!readOnly && (
                <button className="tag-chip tag-chip--add" onClick={() => setShowTagPicker(true)} aria-label="Edit tags">
                  <Plus size={14} />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Dates — when you are here, and for how long.

            One section, many rows: a place can be visited more than once, and
            a trip that opens and closes in the same city is the ordinary case
            rather than the exotic one. Each row is one arrival and one
            departure, and an empty departure means a single day rather than an
            open-ended stay — there is nothing to draw on a timeline for a
            visit with no end, and nothing to be wrong about either.

            Stops only. A spot is somewhere inside a stop, and it is the stop
            you arrive at; giving a café its own arrival date would invite two
            answers to the same question. */}
        {canEditVisits && (
          <div className="detail-section">
            <div className="detail-label-row">
              <label className="detail-label">Dates</label>
              <button
                type="button"
                className="detail-label-add"
                aria-label="Add dates"
                onClick={() => setAddingVisit(true)}
              >
                <Plus size={16} />
              </button>
            </div>

            {placeVisits.length === 0 && (
              <p className="detail-hint">No dates yet.</p>
            )}

            <ul className="visit-rows">
              {placeVisits.map((visit, index) => (
                <li key={visit.id} className="visit-row">
                  {/* Editing an existing visit reopens the same calendar it was
                      created in, so there is one way to express a range rather
                      than one for making it and another for changing it. */}
                  <DateRangeField
                    label={`Visit ${index + 1}`}
                    value={{ start: visit.starts_on, end: visit.ends_on }}
                    title="When are you here?"
                    startLabel="Arrive"
                    endLabel="Depart"
                    year={baseYear(visits)}
                    onChange={async range => {
                      if (!range) return false;
                      return !!(await onUpdateVisit?.(visit.id, { starts_on: range.start, ends_on: range.end }));
                    }}
                  />
                  <button
                    type="button"
                    className="visit-remove"
                    aria-label={`Remove ${visit.starts_on}`}
                    onClick={() => onRemoveVisit?.(visit.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ul>

            {/* A new visit opens straight into the calendar. There is no blank
                row on screen first, because a visit with no dates is not a
                thing this can store — starts_on is not null — and a row that
                cannot be saved yet was exactly what the old draft state
                existed to babysit. */}
            {addingVisit && (
              <DateRangeSheet
                title="When are you here?"
                value={null}
                startLabel="Arrive"
                endLabel="Depart"
                year={baseYear(visits)}
                onCommit={handleAddVisit}
                onClose={() => setAddingVisit(false)}
              />
            )}
          </div>
        )}

        {/* Part of — anchors this place inside another, so the notes page nests
            it under that one instead of giving a café its own top-level
            section next to the city it's in.

            Only stops are offered. That a parent is a stop is the half of the
            model a check constraint cannot see — a check cannot read the
            parent row — so this select is where it is enforced, and
            groupPlaces declines to nest under anything else if it ever isn't.

            Choosing a stop also makes this place a spot: the two are one
            decision, and the database refuses anything anchored that is not
            one. Choosing "Nowhere in particular" turns it back into a stop.

            A place that holds other places cannot be moved into one — it would
            have to become a spot while still holding spots. The select
            is disabled rather than hidden: this is the screen someone comes to
            in order to file a place, and a control that has quietly vanished
            explains nothing. The list view hides its drag grip in the same
            situation because there is nowhere on a row to say why. */}
        {!readOnly && onSetParent && (parentOptions.length > 0 || isOrphanSpot) && (
          <div className="detail-section">
            <label className="detail-label" htmlFor="place-parent">Part of</label>
            <select
              id="place-parent"
              className="input"
              value={place.parent_place_id ?? ''}
              disabled={hasChildren || blockedByDates}
              onChange={e => onSetParent(e.target.value || null)}
            >
              <option value="">Nowhere in particular</option>
              {parentOptions.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {hasChildren && (
              <p className="detail-hint">
                Move the places inside this one out first.
              </p>
            )}
            {/* Named in the same words the database uses, because they are the
                same rule and the section that undoes it is directly above. */}
            {blockedByDates && !hasChildren && (
              <p className="detail-hint">
                Remove this place&rsquo;s dates before making it a spot.
              </p>
            )}
            {isOrphanSpot && !hasChildren && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => onSetParent(null)}
              >
                Make it a stop of its own
              </button>
            )}
          </div>
        )}

        {/* Notes — one row per bullet, each independently editable */}
        {(!readOnly || sharedNotes.length > 0) && (
          <div className="detail-section">
            <div className="detail-label-row">
              <label className="detail-label">Notes</label>
              {!readOnly && (
                // The outliner opens a bullet by tapping the blank part of a
                // section heading; this sheet has no such heading, and when
                // NoteList lost its own add row it lost its only way in — a
                // place with no notes rendered an empty list and nothing to
                // tap. This is that way in.
                <button
                  type="button"
                  className="detail-label-add"
                  aria-label="Add a note"
                  onClick={() => setAddingNote(true)}
                >
                  <Plus size={16} />
                </button>
              )}
            </div>
            {readOnly ? (
              <ul className="note-bullets">
                {normaliseDepths(sharedNotes).map(n => (
                  <li
                    key={n.id}
                    className="note-bullet"
                    style={{ '--note-depth': n.depth } as React.CSSProperties}
                  >
                    <div className="note-bullet-slide">
                      <span className="note-bullet-dot" aria-hidden="true" />
                      <span className="note-bullet-body">
                        {/* Mentions render inert here — no onSelectPlace — but
                            links still resolve, so a shared trip shows the
                            same host pills the editor does. */}
                        <NoteBody body={n.body} places={allPlaces} />
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <NoteList
                notes={notes}
                places={allPlaces}
                onAdd={(body, opts) => onAddNote?.(body, opts)}
                onUpdate={(id, body) => onUpdateNote?.(id, body)}
                // `?? false`, not a bare optional call. deleteNote treats
                // anything but a literal false as "the row went", so an absent
                // handler would have it promote the children of a note that is
                // still there and leave the swiped row parked off-screen,
                // invisible and unswipeable — the exact failure useSwipeToDelete
                // documents. No caller omits these today; the signature invited
                // one to.
                onRemove={(id) => onRemoveNote?.(id) ?? false}
                onRestore={onRestoreNote}
                onSetDepths={(updates) => onSetNoteDepths?.(updates)}
                onReorder={(ids) => onReorderNotes?.(ids)}
                startDraft={addingNote}
                onDraftStarted={() => setAddingNote(false)}
                placeholder="Add a note…"
              />
            )}
          </div>
        )}

        {/* Photos — a small gallery for remembering shot ideas, separate
            from the auto-pulled cover photo above. Tap to open the
            swipeable full-screen viewer. */}
        {(images.length > 0 || !readOnly) && (
          <div className="detail-section">
            <label className="detail-label">Photos</label>
            <div className="image-gallery" ref={galleryRef}>
              {images.map((img, i) => (
                <button
                  key={img.id}
                  className="gallery-thumb-btn"
                  onClick={() => setLightboxIndex(i)}
                >
                  <img src={img.url} alt="" className="gallery-thumb" onError={() => {}} />
                </button>
              ))}
              {!readOnly && (
                <button className="gallery-thumb-btn gallery-thumb-btn--add" onClick={() => setShowAddPhotos(true)} aria-label="Add photos">
                  <Plus size={20} />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Discussion — a multi-author thread for talking a place through,
            distinct from the single-author Notes field above. Collapsible
            so a long thread doesn't bury the rest of the sheet. */}
        <div className="detail-section" ref={discussionRef}>
          <button
            className="detail-label detail-label--toggle"
            onClick={() => setCommentsOpen(o => !o)}
            aria-expanded={commentsOpen}
          >
            <ChevronRight size={14} className={`section-caret ${commentsOpen ? 'section-caret--open' : ''}`} />
            Discussion{comments.length > 0 ? ` · ${comments.length}` : ''}
          </button>

          {!commentsOpen ? null : commentsError ? (
            // A failed load must not masquerade as an empty thread.
            <p className="comments-empty">
              Couldn't load comments.{' '}
              <button className="btn-ghost comments-retry" onClick={reloadComments}>Retry</button>
            </p>
          ) : comments.length === 0 ? (
            <p className="comments-empty">
              {readOnly ? 'No comments yet.' : 'Start the conversation about this place.'}
            </p>
          ) : (
            <ul className="comment-thread">
              {comments.map(c => {
                const mine = c.user_id === currentUserId;
                return (
                  <li key={c.id} className={`comment-row ${mine ? 'comment-row--mine' : ''}`}>
                    {!mine && (
                      <span className="comment-avatar" style={{ background: avatarColor(c.email) }}>
                        {authorName(c.email)[0].toUpperCase()}
                      </span>
                    )}
                    <div className="comment-bubble">
                      <div className="comment-meta">
                        <span className="comment-author">{mine ? 'You' : authorName(c.email)}</span>
                        <span className="comment-time">
                          {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}
                        </span>
                        {mine && !readOnly && (
                          <button
                            className="comment-delete"
                            onClick={() => deleteComment(c.id)}
                            aria-label="Delete comment"
                          >
                            <X size={13} />
                          </button>
                        )}
                      </div>
                      <p className="comment-body">{c.body}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {commentsOpen && !readOnly && (
            <div className="comment-compose">
              <input
                className="input comment-input"
                placeholder="Add a comment…"
                value={commentDraft}
                onChange={e => setCommentDraft(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && handleAddComment()}
              />
              <button
                className="comment-send"
                onClick={handleAddComment}
                disabled={!commentDraft.trim()}
                aria-label="Post comment"
              >
                <SendHorizontal size={18} />
              </button>
            </div>
          )}
        </div>

        {!readOnly && (
          <div className={dirty ? 'detail-actions' : 'sheet-danger-zone'}>
            {showDelete ? (
              <div className="delete-confirm">
                <span>Delete this place?</span>
                <button className="btn-danger" onClick={onDelete}>Delete</button>
                <button className="btn-secondary" onClick={() => setShowDelete(false)}>Cancel</button>
              </div>
            ) : (
              <>
                <button className="btn-ghost btn-danger-ghost" onClick={() => setShowDelete(true)}>
                  <Trash2 size={16} /> Delete
                </button>
                {dirty && (
                  <button className="btn-primary" onClick={handleSave}>
                    <Save size={16} /> Save
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {lightboxIndex !== null && (
        <ImageLightbox
          images={images}
          startIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onRemove={readOnly ? undefined : onRemoveImage}
        />
      )}

      {showAddPhotos && (
        <QuickAddSheet
          title="Add photos"
          onAddUrl={handleAddImageUrl}
          onUpload={onUploadImage ? handleUploadImages : undefined}
          uploadMultiple
          onClose={() => setShowAddPhotos(false)}
        />
      )}

      {showTagPicker && (
        <TagPickerSheet
          allTags={allTags}
          selectedTagIds={selectedTags}
          onToggleTag={toggleTag}
          onCreateTag={onCreateTag}
          onClose={() => setShowTagPicker(false)}
        />
      )}
    </div>
  );
}
