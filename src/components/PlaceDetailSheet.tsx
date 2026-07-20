import { useState, useEffect, useRef } from 'react';
import { useSwipeToClose } from '../hooks/useSwipeToClose';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { ImageLightbox } from './ImageLightbox';
import {
  X, Tag as TagIcon, ExternalLink,
  Trash2, Save, MapPin, Plus, ImageIcon, Upload
} from 'lucide-react';
import type { Place, Tag, PlaceImage } from '../types';
import { TAG_COLORS } from '../constants';
import { format } from 'date-fns';

// Check that draws itself when the parent gains .visited-toggle--visited
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
  const [newSourceUrl, setNewSourceUrl] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>((place.tags ?? []).map(t => t.id));
  const [dirty, setDirty] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [newImageUrl, setNewImageUrl] = useState('');
  const [addingImage, setAddingImage] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const galleryRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showAddTag, setShowAddTag] = useState(false);
  const [quickName, setQuickName] = useState('');
  const [quickColor, setQuickColor] = useState(TAG_COLORS[0].value);
  const [quickIcon, setQuickIcon] = useState('');

  useEffect(() => {
    setNotes(place.notes ?? '');
    setSelectedTags((place.tags ?? []).map(t => t.id));
    setDirty(false);
  }, [place.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const images: PlaceImage[] = place.images ?? [];
  const sourceUrls = place.source_urls ?? [];

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

  const handleAddImage = async () => {
    const url = newImageUrl.trim();
    if (!url) return;
    setAddingImage(true);
    await onAddImage(url);
    setNewImageUrl('');
    setAddingImage(false);
    setTimeout(() => {
      if (galleryRef.current) galleryRef.current.scrollLeft = galleryRef.current.scrollWidth;
    }, 100);
  };

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0 || !onUploadImage) return;
    setUploading(true);
    for (const file of files) {
      await onUploadImage(file);
    }
    setUploading(false);
    setTimeout(() => {
      if (galleryRef.current) galleryRef.current.scrollLeft = galleryRef.current.scrollWidth;
    }, 100);
  };

  // Sources are immediate — persisted on every add/remove, not tied to the
  // notes/tags draft-and-save flow
  const handleAddSource = () => {
    const url = newSourceUrl.trim();
    if (!url) return;
    onUpdate({ source_urls: [...sourceUrls, url] });
    setNewSourceUrl('');
  };

  const handleRemoveSource = (index: number) => {
    onUpdate({ source_urls: sourceUrls.filter((_, i) => i !== index) });
  };

  const handleQuickCreate = async () => {
    if (!quickName.trim() || !onCreateTag) return;
    const tag = await onCreateTag(quickName.trim(), quickColor, quickIcon.trim() || undefined);
    if (tag) {
      setSelectedTags(prev => [...prev, tag.id]);
      setDirty(true);
    }
    setQuickName('');
    setQuickColor(TAG_COLORS[0].value);
    setQuickIcon('');
    setShowAddTag(false);
  };

  const isVisited = place.status === 'visited';
  const { sheetRef, handleProps } = useSwipeToClose(handleClose);

  const displayTags = readOnly
    ? allTags.filter(t => selectedTags.includes(t.id))
    : allTags;

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
            <button className="sheet-close" onClick={handleClose} aria-label="Close"><X size={20} /></button>
          </div>
        )}

        {place.image_url && <h2 className="place-name place-name-below">{place.name}</h2>}

        {place.address && (
          <p className="place-address"><MapPin size={13} /> {place.address}</p>
        )}

        {/* Status */}
        {readOnly ? (
          <div className={`visited-toggle ${isVisited ? 'visited-toggle--visited' : ''} visited-toggle--static`}>
            <CheckRing />
            {isVisited ? `Visited${place.visited_at ? ` · ${format(new Date(place.visited_at), 'MMM d, yyyy')}` : ''}` : 'Planned'}
          </div>
        ) : (
          <button
            className={`visited-toggle ${isVisited ? 'visited-toggle--visited' : ''}`}
            onClick={onToggleVisited}
          >
            <CheckRing />
            {isVisited ? `Visited${place.visited_at ? ` · ${format(new Date(place.visited_at), 'MMM d, yyyy')}` : ''}` : 'Mark as visited'}
          </button>
        )}

        {/* Tags */}
        {(displayTags.length > 0 || (!readOnly && onCreateTag)) && (
          <div className="detail-section">
            <label className="detail-label"><TagIcon size={13} /> Tags</label>
            <div className="tag-chips">
              {displayTags.map(tag => (
                <button
                  key={tag.id}
                  className={`tag-chip ${selectedTags.includes(tag.id) ? 'tag-chip--active' : ''}`}
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
              {!readOnly && onCreateTag && !showAddTag && (
                <button className="tag-chip tag-chip--add" onClick={() => setShowAddTag(true)} aria-label="New tag">
                  <Plus size={14} />
                </button>
              )}
            </div>
            {showAddTag && (
              <div className="quick-tag-form">
                <div className="tag-create-row">
                  <div className="icon-input-wrap">
                    <input
                      className="input icon-input"
                      placeholder="😀"
                      maxLength={2}
                      value={quickIcon}
                      onChange={e => setQuickIcon(e.target.value)}
                    />
                  </div>
                  <input
                    className="input"
                    placeholder="Tag name"
                    value={quickName}
                    onChange={e => setQuickName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleQuickCreate();
                      if (e.key === 'Escape') { setShowAddTag(false); setQuickIcon(''); }
                    }}
                    autoFocus
                  />
                </div>
                <div className="color-presets">
                  {TAG_COLORS.map(c => (
                    <button
                      key={c.value}
                      className={`color-preset ${quickColor === c.value ? 'color-preset--active' : ''}`}
                      style={{ background: c.value }}
                      onClick={() => setQuickColor(c.value)}
                      aria-label={c.name}
                    />
                  ))}
                </div>
                <div className="form-actions">
                  <button className="btn-secondary" onClick={() => { setShowAddTag(false); setQuickIcon(''); }}>Cancel</button>
                  <button className="btn-primary" onClick={handleQuickCreate} disabled={!quickName.trim()}>Add</button>
                </div>
              </div>
            )}
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
            <label className="detail-label">
              <ExternalLink size={13} /> Sources
            </label>
            {sourceUrls.length > 0 && (
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
              </div>
            )}
            {!readOnly && (
              <div className="add-image-row">
                <input
                  type="url"
                  className="input"
                  placeholder="https://…"
                  value={newSourceUrl}
                  onChange={e => setNewSourceUrl(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddSource()}
                />
                <button
                  className="btn-icon"
                  onClick={handleAddSource}
                  disabled={!newSourceUrl.trim()}
                  aria-label="Add source"
                >
                  <Plus size={20} />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Photos — a small gallery for remembering shot ideas, separate
            from the auto-pulled cover photo above. Tap to open the
            swipeable full-screen viewer. */}
        {images.length > 0 && (
          <div className="detail-section">
            <label className="detail-label"><ImageIcon size={13} /> Photos</label>
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
            </div>
          </div>
        )}

        {/* Add photos */}
        {!readOnly && (
          <div className="detail-section">
            <label className="detail-label"><ImageIcon size={13} /> Add photos</label>
            <div className="add-image-row">
              <input
                type="url"
                className="input"
                placeholder="https://…"
                value={newImageUrl}
                onChange={e => setNewImageUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddImage()}
              />
              <button
                className="btn-icon"
                onClick={handleAddImage}
                disabled={!newImageUrl.trim() || addingImage}
                aria-label="Add from URL"
              >
                <Plus size={20} />
              </button>
            </div>
            {onUploadImage && (
              <>
                <button
                  className="btn-secondary upload-photos-btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  <Upload size={16} />
                  {uploading ? 'Uploading…' : 'Upload from device'}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="visually-hidden"
                  onChange={handleFilesSelected}
                />
              </>
            )}
          </div>
        )}

        {!readOnly && (
          <div className="detail-actions">
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
    </div>
  );
}
