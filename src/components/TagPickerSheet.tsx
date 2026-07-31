import { useState } from 'react';
import { X, Plus } from 'lucide-react';
import { useSwipeToClose } from '../hooks/useSwipeToClose';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { TAG_COLORS, SUGGESTED_ICONS } from '../constants';
import type { Tag } from '../types';

interface Props {
  allTags: Tag[];
  selectedTagIds: string[];
  onToggleTag: (id: string) => void;
  onCreateTag?: (name: string, color: string, icon?: string) => Promise<Tag | null>;
  onClose: () => void;
}

// Full trip tag list, opened from the place sheet's "+" — lets you pick
// from every tag on the trip (not just the ones already on this place)
// or create a new one, which becomes a trip-wide tag going forward.
export function TagPickerSheet({ allTags, selectedTagIds, onToggleTag, onCreateTag, onClose }: Props) {
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(TAG_COLORS[0].value);
  const [newIcon, setNewIcon] = useState('');
  const [creating, setCreating] = useState(false);
  const { sheetRef, handleProps } = useSwipeToClose(onClose);
  useEscapeClose(onClose);

  // Reentry guard: Enter in the name input calls this directly, and repeated
  // presses during the await would create duplicate tags.
  const handleCreate = async () => {
    if (!newName.trim() || !onCreateTag || creating) return;
    setCreating(true);
    try {
      const tag = await onCreateTag(newName.trim(), newColor, newIcon.trim() || undefined);
      if (tag) onToggleTag(tag.id);
      setNewName('');
      setNewColor(TAG_COLORS[0].value);
      setNewIcon('');
      setShowCreate(false);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="bottom-sheet-overlay" onClick={e => { e.stopPropagation(); onClose(); }}>
      <div
        className="bottom-sheet"
        ref={sheetRef}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Tags"
      >
        <div className="bottom-sheet-handle" {...handleProps} />
        <div className="sheet-header-row">
          <h2 className="bottom-sheet-title">Tags</h2>
          <button className="sheet-close" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>

        <div className="tag-chips">
          {allTags.map(tag => (
            <button
              key={tag.id}
              className={`tag-chip ${selectedTagIds.includes(tag.id) ? 'tag-chip--active' : ''}`}
              style={{ '--tag-color': tag.color } as React.CSSProperties}
              onClick={() => onToggleTag(tag.id)}
            >
              {tag.icon
                ? <span>{tag.icon}</span>
                : <span className="tag-chip-dot" style={{ background: tag.color }} />}
              {tag.name}
            </button>
          ))}
          {onCreateTag && !showCreate && (
            <button className="tag-chip tag-chip--add" onClick={() => setShowCreate(true)} aria-label="New tag">
              <Plus size={14} />
            </button>
          )}
        </div>

        {showCreate && (
          <div className="quick-tag-form">
            <div className="tag-create-row">
              <div className="icon-input-wrap">
                <input
                  className="input icon-input"
                  placeholder="😀"
                  maxLength={2}
                  value={newIcon}
                  onChange={e => setNewIcon(e.target.value)}
                />
              </div>
              <input
                className="input"
                placeholder="Tag name"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleCreate();
                  if (e.key === 'Escape') {
                    // Cancel the inline form only — without stopPropagation
                    // the window-level escape stack would close the sheet too.
                    e.stopPropagation();
                    setShowCreate(false);
                    setNewIcon('');
                  }
                }}
                autoFocus
              />
            </div>
            {/* Same suggested-emoji row as the tag manager — creating a tag
                from here used to offer only the free-text field, so the two
                create forms produced different-looking tags. */}
            <div className="icon-presets">
              {SUGGESTED_ICONS.map(ic => (
                <button
                  key={ic}
                  className={`icon-preset ${newIcon === ic ? 'icon-preset--active' : ''}`}
                  onClick={() => setNewIcon(newIcon === ic ? '' : ic)}
                >
                  {ic}
                </button>
              ))}
            </div>
            <div className="color-presets">
              {TAG_COLORS.map(c => (
                <button
                  key={c.value}
                  className={`color-preset ${newColor === c.value ? 'color-preset--active' : ''}`}
                  style={{ background: c.value }}
                  onClick={() => setNewColor(c.value)}
                  aria-label={c.name}
                />
              ))}
            </div>
            <div className="form-actions">
              <button className="btn-secondary" onClick={() => { setShowCreate(false); setNewIcon(''); }}>Cancel</button>
              <button className="btn-primary" onClick={handleCreate} disabled={!newName.trim() || creating}>Add</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
