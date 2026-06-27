import { useState, useEffect } from 'react';
import {
  X, CheckCircle, Circle, Tag as TagIcon, ExternalLink,
  Trash2, Save, MapPin
} from 'lucide-react';
import type { Place, Tag } from '../types';
import { format } from 'date-fns';

interface Props {
  place: Place;
  allTags: Tag[];
  onClose: () => void;
  onToggleVisited: () => void;
  onUpdate: (updates: Partial<Place>) => void;
  onDelete: () => void;
  onSetTags: (tagIds: string[]) => void;
}

export function PlaceDetailSheet({
  place, allTags, onClose, onToggleVisited, onUpdate, onDelete, onSetTags
}: Props) {
  const [notes, setNotes] = useState(place.notes ?? '');
  const [sourceUrl, setSourceUrl] = useState(place.source_url ?? '');
  const [imageUrl, setImageUrl] = useState(place.image_url ?? '');
  const [selectedTags, setSelectedTags] = useState<string[]>((place.tags ?? []).map(t => t.id));
  const [dirty, setDirty] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  useEffect(() => {
    setNotes(place.notes ?? '');
    setSourceUrl(place.source_url ?? '');
    setImageUrl(place.image_url ?? '');
    setSelectedTags((place.tags ?? []).map(t => t.id));
    setDirty(false);
  }, [place.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = () => {
    onUpdate({ notes: notes || undefined, source_url: sourceUrl || undefined, image_url: imageUrl || undefined });
    onSetTags(selectedTags);
    setDirty(false);
  };

  const toggleTag = (id: string) => {
    setSelectedTags(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id]);
    setDirty(true);
  };

  const isVisited = place.status === 'visited';

  return (
    <div className="bottom-sheet-overlay" onClick={onClose}>
      <div className="bottom-sheet place-detail-sheet" onClick={e => e.stopPropagation()}>
        <div className="bottom-sheet-handle" />

        {imageUrl ? (
          <div className="place-image-wrap">
            <img src={imageUrl} alt={place.name} className="place-image" onError={() => setImageUrl('')} />
            <button className="sheet-close" onClick={onClose}><X size={20} /></button>
          </div>
        ) : (
          <div className="sheet-header-row">
            <h2 className="place-name">{place.name}</h2>
            <button className="sheet-close" onClick={onClose}><X size={20} /></button>
          </div>
        )}

        {imageUrl && <h2 className="place-name place-name-below">{place.name}</h2>}

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
        {allTags.length > 0 && (
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
                  {tag.name}
                </button>
              ))}
            </div>
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
            <ExternalLink size={13} /> Source URL
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
              Open link <ExternalLink size={12} />
            </a>
          )}
        </div>

        {/* Image URL */}
        <div className="detail-section">
          <label className="detail-label">Image URL</label>
          <input
            type="url"
            className="input"
            placeholder="https://…"
            value={imageUrl}
            onChange={e => { setImageUrl(e.target.value); setDirty(true); }}
          />
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
