import { useState } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import type { Tag } from '../types';

const PRESET_COLORS = [
  '#6366f1', '#ec4899', '#f59e0b', '#10b981',
  '#3b82f6', '#ef4444', '#8b5cf6', '#14b8a6',
];

const SUGGESTED_ICONS = ['📍', '🍔', '📷', '🏛️', '🏖️', '🛍️', '☕', '🍷', '🏨', '🎭', '🌿', '⛪'];

const TAG_PRESETS = [
  { name: 'Food',          icon: '🍔', color: '#ef4444' },
  { name: 'Photography',   icon: '📷', color: '#3b82f6' },
  { name: 'Accommodation', icon: '🏨', color: '#8b5cf6' },
  { name: 'Outdoor',       icon: '🌿', color: '#10b981' },
  { name: 'Coffee',        icon: '☕', color: '#f59e0b' },
];

interface Props {
  tags: Tag[];
  activeTags: string[];
  onToggleTag: (id: string) => void;
  onClearTags: () => void;
  onCreateTag: (name: string, color: string, icon?: string) => void;
  onDeleteTag: (id: string) => void;
  onClose: () => void;
}

export function TagFilterSheet({
  tags, activeTags, onToggleTag, onClearTags, onCreateTag, onDeleteTag, onClose
}: Props) {
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(PRESET_COLORS[0]);
  const [newIcon, setNewIcon] = useState('');

  const handleCreate = () => {
    if (!newName.trim()) return;
    onCreateTag(newName.trim(), newColor, newIcon.trim() || undefined);
    setNewName('');
    setNewColor(PRESET_COLORS[0]);
    setNewIcon('');
    setShowCreate(false);
  };

  const availablePresets = TAG_PRESETS.filter(
    p => !tags.some(t => t.name.toLowerCase() === p.name.toLowerCase())
  );

  return (
    <div className="bottom-sheet-overlay" onClick={onClose}>
      <div className="bottom-sheet" onClick={e => e.stopPropagation()}>
        <div className="bottom-sheet-handle" />
        <div className="sheet-header-row">
          <h2 className="bottom-sheet-title">Tags</h2>
          <button className="sheet-close" onClick={onClose}><X size={20} /></button>
        </div>

        {activeTags.length > 0 && (
          <button className="btn-ghost" onClick={onClearTags} style={{ marginBottom: '8px' }}>
            Clear filter ({activeTags.length})
          </button>
        )}

        <div className="tag-list">
          {tags.map(tag => (
            <div key={tag.id} className="tag-filter-row">
              <button
                className={`tag-filter-chip ${activeTags.includes(tag.id) ? 'tag-filter-chip--active' : ''}`}
                style={{ '--tag-color': tag.color } as React.CSSProperties}
                onClick={() => onToggleTag(tag.id)}
              >
                {tag.icon ? (
                  <span className="tag-icon">{tag.icon}</span>
                ) : (
                  <span className="tag-dot" style={{ background: tag.color }} />
                )}
                {tag.name}
              </button>
              <button className="btn-icon btn-icon-sm" onClick={() => onDeleteTag(tag.id)} aria-label="Delete tag">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>

        {!showCreate && availablePresets.length > 0 && (
          <div className="tag-presets">
            {availablePresets.map(p => (
              <button
                key={p.name}
                className="tag-preset-chip"
                onClick={() => onCreateTag(p.name, p.color, p.icon)}
              >
                <span>{p.icon}</span>
                {p.name}
              </button>
            ))}
          </div>
        )}

        {showCreate ? (
          <div className="create-tag-form">
            <div className="tag-create-row">
              <div className="icon-input-wrap">
                <input
                  className="input icon-input"
                  placeholder="😀"
                  value={newIcon}
                  onChange={e => setNewIcon(e.target.value)}
                  maxLength={2}
                />
              </div>
              <input
                className="input"
                placeholder="Tag name"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                autoFocus
              />
            </div>
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
              {PRESET_COLORS.map(c => (
                <button
                  key={c}
                  className={`color-preset ${newColor === c ? 'color-preset--active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setNewColor(c)}
                  aria-label={c}
                />
              ))}
            </div>
            <div className="form-actions">
              <button className="btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="btn-primary" onClick={handleCreate} disabled={!newName.trim()}>Create</button>
            </div>
          </div>
        ) : (
          <button className="btn-ghost" onClick={() => setShowCreate(true)}>
            <Plus size={16} /> New tag
          </button>
        )}
      </div>
    </div>
  );
}
