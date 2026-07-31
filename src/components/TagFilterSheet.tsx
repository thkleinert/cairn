import { useState } from 'react';
import { X, Plus, Trash2, Pencil, Check } from 'lucide-react';
import type { Tag } from '../types';
import { useSwipeToClose } from '../hooks/useSwipeToClose';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { TAG_COLORS, SUGGESTED_ICONS } from '../constants';


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
  const [newColor, setNewColor] = useState(TAG_COLORS[0].value);
  const [newIcon, setNewIcon] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState(TAG_COLORS[0].value);
  const [editIcon, setEditIcon] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEscapeClose(onClose);

  const handleCreate = () => {
    if (!newName.trim()) return;
    onCreateTag(newName.trim(), newColor, newIcon.trim() || undefined);
    setNewName('');
    setNewColor(TAG_COLORS[0].value);
    setNewIcon('');
    setShowCreate(false);
  };

  const startEdit = (tag: Tag) => {
    setEditingId(tag.id);
    setEditName(tag.name);
    setEditColor(tag.color);
    setEditIcon(tag.icon ?? '');
    setShowCreate(false);
    setConfirmDeleteId(null);
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

        {activeTags.length > 0 && (
          <button className="btn-ghost u-mb8" onClick={onClearTags}>
            Clear filter ({activeTags.length})
          </button>
        )}

        <div className="tag-list">
          {tags.map(tag => (
            <div key={tag.id}>
              {editingId === tag.id ? (
                <div className="create-tag-form u-mb8">
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
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleSaveEdit();
                        if (e.key === 'Escape') {
                          // Cancel the rename only — without stopPropagation
                          // the escape stack would also dismiss the sheet.
                          e.stopPropagation();
                          cancelEdit();
                        }
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
                    {TAG_COLORS.map(c => (
                      <button
                        key={c.value}
                        className={`color-preset ${editColor === c.value ? 'color-preset--active' : ''}`}
                        style={{ background: c.value }}
                        onClick={() => setEditColor(c.value)}
                        aria-label={c.name}
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
                  {confirmDeleteId === tag.id ? (
                    <>
                      <button
                        className="btn-icon btn-icon-sm tag-delete-confirm"
                        onClick={() => { onDeleteTag(tag.id); setConfirmDeleteId(null); }}
                        aria-label={`Confirm delete ${tag.name}`}
                      >
                        <Check size={14} />
                      </button>
                      <button
                        className="btn-icon btn-icon-sm"
                        onClick={() => setConfirmDeleteId(null)}
                        aria-label="Cancel delete"
                      >
                        <X size={14} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="btn-icon btn-icon-sm" onClick={() => startEdit(tag)} aria-label={`Edit ${tag.name}`}>
                        <Pencil size={14} />
                      </button>
                      <button className="btn-icon btn-icon-sm" onClick={() => setConfirmDeleteId(tag.id)} aria-label={`Delete ${tag.name}`}>
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
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
