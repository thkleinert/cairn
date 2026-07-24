import { useState, useEffect, useRef } from 'react';
import { useSwipeToClose } from '../hooks/useSwipeToClose';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { useComments } from '../hooks/useComments';
import { ImageLightbox } from './ImageLightbox';
import { QuickAddSheet } from './QuickAddSheet';
import { TagPickerSheet } from './TagPickerSheet';
import {
  X, ExternalLink,
  Trash2, Save, MapPin, Plus, SendHorizontal, ChevronRight
} from 'lucide-react';
import type { Place, Tag, PlaceImage } from '../types';
import { format, formatDistanceToNow } from 'date-fns';
import { TAG_COLORS } from '../constants';

// Deterministic avatar tint per author, so each person keeps one colour
// across the thread — same idea as tag colours, hashed off the email.
function avatarColor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) hash = (hash * 31 + email.charCodeAt(i)) | 0;
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length].value;
}

function authorName(email: string): string {
  return email.split('@')[0];
}

// Check that draws itself when the parent gains .visited-icon-btn--visited
function CheckRing() {
  return (
    <svg className="check-ring" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <circle className="check-ring-circle" cx="10" cy="10" r="8.5" fill="none" strokeWidth="1.5" />
      <path className="check-ring-path" d="M6 10.2l2.6 2.6L14 7.4" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

interface Props {
  place: Place;
  allTags: Tag[];
  onClose: () => void;
  onToggleVisited: () => void;
  onUpdate: (updates: Partial<Place>) => void;
  onDelete: () => void;
  onSetTags: (tagIds: string[]) => void;
  onAddImage: (url: string, caption?: string) => Promise<PlaceImage | null>;
  onUploadImage?: (file: File) => Promise<PlaceImage | null>;
  onRemoveImage: (imageId: string) => void;
  onCreateTag?: (name: string, color: string, icon?: string) => Promise<Tag | null>;
  readOnly?: boolean;
}

export function PlaceDetailSheet({
  place, allTags, onClose, onToggleVisited, onUpdate, onDelete,
  onSetTags, onAddImage, onUploadImage, onRemoveImage, onCreateTag, readOnly = false,
}: Props) {
  const [notes, setNotes] = useState(place.notes ?? '');
  const [selectedTags, setSelectedTags] = useState<string[]>((place.tags ?? []).map(t => t.id));
  const [dirty, setDirty] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [showAddPhotos, setShowAddPhotos] = useState(false);
  const [showAddSource, setShowAddSource] = useState(false);
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');
  const [commentsOpen, setCommentsOpen] = useState(true);
  const galleryRef = useRef<HTMLDivElement>(null);

  const { comments, currentUserId, addComment, deleteComment } = useComments(place.id);

  const handleAddComment = async () => {
    const body = commentDraft.trim();
    if (!body) return;
    setCommentDraft('');
    await addComment(body);
  };

  useEffect(() => {
    setNotes(place.notes ?? '');
    setSelectedTags((place.tags ?? []).map(t => t.id));
    setDirty(false);
  }, [place.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const images: PlaceImage[] = place.images ?? [];
  const sourceUrls = place.source_urls ?? [];
  const assignedTags = allTags.filter(t => selectedTags.includes(t.id));

  const handleSave = () => {
    onUpdate({ notes: notes || undefined });
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

  // Sources are immediate — persisted on every add/remove, not tied to the
  // notes/tags draft-and-save flow
  const handleAddSource = (url: string) => {
    onUpdate({ source_urls: [...sourceUrls, url] });
  };

  const handleRemoveSource = (index: number) => {
    onUpdate({ source_urls: sourceUrls.filter((_, i) => i !== index) });
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

        {/* Notes */}
        {(!readOnly || notes) && (
          <div className="detail-section">
            <label className="detail-label">Notes</label>
            {readOnly ? (
              <p className="detail-static-text">{notes}</p>
            ) : (
              <textarea
                className="input detail-textarea"
                placeholder="Add notes…"
                value={notes}
                onChange={e => { setNotes(e.target.value); setDirty(true); }}
                rows={3}
              />
            )}
          </div>
        )}

        {/* Sources — multiple URLs, each a removable pill once added */}
        {(!readOnly || sourceUrls.length > 0) && (
          <div className="detail-section">
            <label className="detail-label">Sources</label>
            <div className="source-pills">
              {sourceUrls.map((url, i) => (
                <span key={i} className="source-pill">
                  <a href={url} target="_blank" rel="noopener noreferrer" className="source-pill-link">
                    <ExternalLink size={11} /> {displayHost(url)}
                  </a>
                  {!readOnly && (
                    <button
                      className="source-pill-remove"
                      onClick={() => handleRemoveSource(i)}
                      aria-label={`Remove source ${displayHost(url)}`}
                    >
                      <X size={11} />
                    </button>
                  )}
                </span>
              ))}
              {!readOnly && (
                <button className="source-pill source-pill--add" onClick={() => setShowAddSource(true)} aria-label="Add source">
                  <Plus size={13} />
                </button>
              )}
            </div>
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
        <div className="detail-section">
          <button
            className="detail-label detail-label--toggle"
            onClick={() => setCommentsOpen(o => !o)}
            aria-expanded={commentsOpen}
          >
            <ChevronRight size={14} className={`section-caret ${commentsOpen ? 'section-caret--open' : ''}`} />
            Discussion{comments.length > 0 ? ` · ${comments.length}` : ''}
          </button>

          {!commentsOpen ? null : comments.length === 0 ? (
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
                onKeyDown={e => e.key === 'Enter' && handleAddComment()}
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

      {showAddSource && (
        <QuickAddSheet
          title="Add source"
          onAddUrl={handleAddSource}
          onClose={() => setShowAddSource(false)}
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
