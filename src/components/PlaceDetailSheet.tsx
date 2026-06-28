import { useState, useEffect, useRef } from 'react';
import { useSwipeToClose } from '../hooks/useSwipeToClose';
import {
  X, CheckCircle, Circle, Tag as TagIcon, ExternalLink,
  Trash2, Save, MapPin, Plus, ImageIcon
} from 'lucide-react';
import type { Place, Tag, PlaceImage } from '../types';
import { format } from 'date-fns';

const QUICK_COLORS = [
  '#6366f1', '#ec4899', '#f59e0b', '#10b981',
  '#3b82f6', '#ef4444', '#8b5cf6', '#14b8a6',
];

interface Props {
  place: Place;
  allTags: Tag[];
  onClose: () => void;
  onToggleVisited: () => void;
  onUpdate: (updates: Partial<Place>) => void;
  onDelete: () => void;
  onSetTags: (tagIds: string[]) => void;
  onAddImage: (url: string, caption?: string) => Promise<PlaceImage | null>;
  onRemoveImage: (imageId: string) => void;
  onCreateTag?: (name: string, color: string, icon?: string) => Promise<Tag | null>;
}

export function PlaceDetailSheet({
  place, allTags, onClose, onToggleVisited, onUpdate, onDelete,
  onSetTags, onAddImage, onRemoveImage, onCreateTag,
}: Props) {
  const [notes, setNotes] = useState(place.notes ?? '');
  const [sourceUrl, setSourceUrl] = useState(place.source_url ?? '');
  const [selectedTags, setSelectedTags] = useState<string[]>((place.tags ?? []).map(t => t.id));
  const [dirty, setDirty] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [newImageUrl, setNewImageUrl] = useState('');
  const [addingImage, setAddingImage] = useState(false);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const galleryRef = useRef<HTMLDivElement>(null);
  const [showAddTag, setShowAddTag] = useState(false);
  const [quickName, setQuickName] = useState('');
  const [quickColor, setQuickColor] = useState(QUICK_COLORS[0]);

  useEffect(() => {
    setNotes(place.notes ?? '');
    setSourceUrl(place.source_url ?? '');
    setSelectedTags((place.tags ?? []).map(t => t.id));
    setDirty(false);
    setActiveImageIndex(0);
  }, [place.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const images: PlaceImage[] = place.images ?? [];

  const handleSave = () => {
    onUpdate({ notes: notes || undefined, source_url: sourceUrl || undefined });
    onSetTags(selectedTags);
    setDirty(false);
  };

  const toggleTag = (id: string) => {
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
    // scroll gallery to end
    setTimeout(() => {
      if (galleryRef.current) {
        galleryRef.current.scrollLeft = galleryRef.current.scrollWidth;
        setActiveImageIndex(images.length); // will be the new last index
      }
    }, 100);
  };

  const handleQuickCreate = async () => {
    if (!quickName.trim() || !onCreateTag) return;
    const tag = await onCreateTag(quickName.trim(), quickColor);
    if (tag) {
      setSelectedTags(prev => [...prev, tag.id]);
      setDirty(true);
    }
    setQuickName('');
    setQuickColor(QUICK_COLORS[0]);
    setShowAddTag(false);
  };

  const isVisited = place.status === 'visited';
  const heroImage = images[activeImageIndex] ?? null;
  const { sheetRef, handleProps } = useSwipeToClose(onClose);

  return (
    <div className="bottom-sheet-overlay" onClick={onClose}>
      <div className="bottom-sheet place-detail-sheet" ref={sheetRef} onClick={e => e.stopPropagation()}>
        <div className="bottom-sheet-handle" {...handleProps} />

        {/* Image gallery hero */}
        {heroImage ? (
          <div className="place-image-wrap">
            <img src={heroImage.url} alt={place.name} className="place-image" onError={() => {}} />
            <button className="sheet-close" onClick={onClose}><X size={20} /></button>
            {images.length > 1 && (
              <div className="image-dots">
                {images.map((_, i) => (
                  <button
                    key={i}
                    className={`image-dot ${i === activeImageIndex ? 'image-dot--active' : ''}`}
                    onClick={() => setActiveImageIndex(i)}
                  />
                ))}
              </div>
            )}
            <button
              className="image-remove-btn"
              onClick={() => {
                onRemoveImage(heroImage.id);
                setActiveImageIndex(Math.max(0, activeImageIndex - 1));
              }}
              aria-label="Remove image"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ) : (
          <div className="sheet-header-row">
            <h2 className="place-name">{place.name}</h2>
            <button className="sheet-close" onClick={onClose}><X size={20} /></button>
          </div>
        )}

        {heroImage && <h2 className="place-name place-name-below">{place.name}</h2>}

        {place.address && (
          <p className="place-address"><MapPin size={13} /> {place.address}</p>
        )}

        {/* Status toggle */}
        <button
          className={`visited-toggle ${isVisited ? 'visited-toggle--visited' : ''}`}
          onClick={onToggleVisited}
        >
          {isVisited ? <CheckCircle size={18} /> : <Circle size={18} />}
          {isVisited ? `Visited${place.visited_at ? ` · ${format(new Date(place.visited_at), 'MMM d, yyyy')}` : ''}` : 'Mark as visited'}
        </button>

        {/* Tags */}
        {(allTags.length > 0 || onCreateTag) && (
          <div className="detail-section">
            <label className="detail-label"><TagIcon size={13} /> Tags</label>
            <div className="tag-chips">
              {allTags.map(tag => (
                <button
                  key={tag.id}
                  className={`tag-chip ${selectedTags.includes(tag.id) ? 'tag-chip--active' : ''}`}
                  style={{ '--tag-color': tag.color } as React.CSSProperties}
                  onClick={() => toggleTag(tag.id)}
                >
                  {tag.icon && <span>{tag.icon}</span>}
                  {tag.name}
                </button>
              ))}
              {onCreateTag && !showAddTag && (
                <button className="tag-chip tag-chip--add" onClick={() => setShowAddTag(true)} aria-label="New tag">
                  <Plus size={14} />
                </button>
              )}
            </div>
            {showAddTag && (
              <div className="quick-tag-form">
                <input
                  className="input"
                  placeholder="Tag name"
                  value={quickName}
                  onChange={e => setQuickName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleQuickCreate();
                    if (e.key === 'Escape') setShowAddTag(false);
                  }}
                  autoFocus
                />
                <div className="color-presets">
                  {QUICK_COLORS.map(c => (
                    <button
                      key={c}
                      className={`color-preset ${quickColor === c ? 'color-preset--active' : ''}`}
                      style={{ background: c }}
                      onClick={() => setQuickColor(c)}
                      aria-label={c}
                    />
                  ))}
                </div>
                <div className="form-actions">
                  <button className="btn-secondary" onClick={() => setShowAddTag(false)}>Cancel</button>
                  <button className="btn-primary" onClick={handleQuickCreate} disabled={!quickName.trim()}>Add</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Notes */}
        <div className="detail-section">
          <label className="detail-label">Notes</label>
          <textarea
            className="input detail-textarea"
            placeholder="Add notes…"
            value={notes}
            onChange={e => { setNotes(e.target.value); setDirty(true); }}
            rows={3}
          />
        </div>

        {/* Source URL */}
        <div className="detail-section">
          <label className="detail-label">
            <ExternalLink size={13} /> Source
          </label>
          <input
            type="url"
            className="input"
            placeholder="https://…"
            value={sourceUrl}
            onChange={e => { setSourceUrl(e.target.value); setDirty(true); }}
          />
          {sourceUrl && (
            <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="source-link">
              Open <ExternalLink size={12} />
            </a>
          )}
        </div>

        {/* Image gallery thumbnails */}
        {images.length > 0 && (
          <div className="detail-section">
            <label className="detail-label"><ImageIcon size={13} /> Photos</label>
            <div className="image-gallery" ref={galleryRef}>
              {images.map((img, i) => (
                <button
                  key={img.id}
                  className={`gallery-thumb-btn ${i === activeImageIndex ? 'gallery-thumb-btn--active' : ''}`}
                  onClick={() => setActiveImageIndex(i)}
                >
                  <img src={img.url} alt="" className="gallery-thumb" onError={() => {}} />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Add image */}
        <div className="detail-section">
          <label className="detail-label"><ImageIcon size={13} /> Add photo URL</label>
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
              aria-label="Add image"
            >
              <Plus size={20} />
            </button>
          </div>
        </div>

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
      </div>
    </div>
  );
}
