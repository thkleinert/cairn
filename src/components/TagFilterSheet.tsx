import { useState } from 'react';
import { X, Plus, Trash2, Pencil } from 'lucide-react';
import type { Tag } from '../types';
import { useSwipeToClose } from '../hooks/useSwipeToClose';

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
  onUpdateTag: (id: string, updates: { name?: string; color?: string; icon?: string | null }) => void;
  onClose: () => void;
}

export function TagFilterSheet({
  tags, activeTags, onToggleTag, onClearTags, onCreateTag, onDeleteTag, onUpdateTag, onClose
}: Props) {
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(PRESET_COLORS[0]);
  const [newIcon, setNewIcon] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState(PRESET_COLORS[0]);
  const [editIcon, setEditIcon] = useState('');

  const handleCreate = () => {
    if (!newName.trim()) return;
    onCreateTag(newName.trim(), newColor, newIcon.trim() || undefined);
    setNewName('');
    setNewColor(PRESET_COLORS[0]);
    setNewIcon('');
    setShowCreate(false);
  };

  const startEdit = (tag: Tag) => {
    setEditingId(tag.id);
    setEditName(tag.name);
    setEditColor(tag.color);
    setEditIcon(tag.icon ?? '');
    setShowCreate(false);
  };

  const cancelEdit = () => setEditingId(null);

  const handleSaveEdit = () => {
    if (!editingId || !editName.trim()) return;
    onUpdateTag(editingId, {
      name: editName.trim(),
      color: editColor,
      icon: editIcon.trim() || null,
    });
    setEditingId(null);
  };

  const availablePresets = TAG_PRESETS.filter(
    p => !tags.some(t => t.name.toLowerCase() === p.name.toLowerCase())
  );

  const { sheetRef, handleProps } = useSwipeToClose(onClose);

  return (
    <div className="bottom-sheet-overlay" onClick={onClose}>
      <div className="bottom-sheet" ref={sheetRef} onClick={e => e.stopPropagation()}>
        <div className="bottom-sheet-handle" {...handleProps} />
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
            <div key={tag.id}>
              {editingId === tag.id ? (
                <div className="create-tag-form" style={{ marginBottom: '4px' }}>
                  <div className="tag-create-row">
                    <div className="icon-input-wrap">
                      <input
                        className="input icon-input"
                        placeholder="😀"
                        maxLength={2}
                        value={editIcon}
                        onChange={e => setEditIcon(e.target.value)}
                      />
                    </div>
                    <input
                      className="input"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleSaveEdit();
                        if (e.key === 'Escape') cancelEdit();
                      }}
                      autoFocus
                    />
                  </div>
                  <div className="icon-presets">
                    {SUGGESTED_ICONS.map(ic => (
                      <button
                        key={ic}
                        className={`icon-preset ${editIcon === ic ? 'icon-preset--active' : ''}`}
                        onClick={() => setEditIcon(editIcon === ic ? '' : ic)}
                      >
                        {ic}
                      </button>
                    ))}
                  </div>
                  <div className="color-presets">
                    {PRESET_COLORS.map(c => (
                      <button
                        key={c}
                        className={`color-preset ${editColor === c ? 'color-preset--active' : ''}`}
                        style={{ background: c }}
                        onClick={() => setEditColor(c)}
                        aria-label={c}
                      />
                    ))}
                  </div>
                  <div className="form-actions">
                    <button className="btn-secondary" onClick={cancelEdit}>Cancel</button>
                    <button className="btn-primary" onClick={handleSaveEdit} disabled={!editName.trim()}>Save</button>
                  </div>
                </div>
              ) : (
                <div className="tag-filter-row">
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
                  <button className="btn-icon btn-icon-sm" onClick={() => startEdit(tag)} aria-label="Edit tag">
                    <Pencil size={14} />
                  </button>
                  <button className="btn-icon btn-icon-sm" onClick={() => onDeleteTag(tag.id)} aria-label="Delete tag">
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {!showCreate && !editingId && availablePresets.length > 0 && (
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

        {!editingId && (showCreate ? (
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
        ))}
      </div>
    </div>
  );
}
