import { useState } from 'react';
import { X, Copy, Check, Users, Trash2 } from 'lucide-react';
import type { Trip } from '../types';

interface Props {
  trip: Trip;
  onClose: () => void;
  onUpdate: (updates: Partial<Trip>) => void;
  onDelete: () => void;
  isOwner: boolean;
}

export function TripSettingsSheet({ trip, onClose, onUpdate, onDelete, isOwner }: Props) {
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState(trip.name);
  const [status, setStatus] = useState(trip.status);
  const [showDelete, setShowDelete] = useState(false);

  const shareUrl = `${window.location.origin}/shared/${trip.share_token}`;

  const copyLink = async () => {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSave = () => {
    onUpdate({ name, status });
    onClose();
  };

  return (
    <div className="bottom-sheet-overlay" onClick={onClose}>
      <div className="bottom-sheet" onClick={e => e.stopPropagation()}>
        <div className="bottom-sheet-handle" />
        <div className="sheet-header-row">
          <h2 className="bottom-sheet-title">Trip Settings</h2>
          <button className="sheet-close" onClick={onClose}><X size={20} /></button>
        </div>

        {isOwner && (
          <>
            <div className="detail-section">
              <label className="detail-label">Name</label>
              <input className="input" value={name} onChange={e => setName(e.target.value)} />
            </div>

            <div className="detail-section">
              <label className="detail-label">Status</label>
              <select
                className="input"
                value={status}
                onChange={e => setStatus(e.target.value as Trip['status'])}
              >
                <option value="planning">Planning</option>
                <option value="ongoing">Ongoing</option>
                <option value="completed">Completed</option>
              </select>
            </div>

            <button className="btn-primary" onClick={handleSave} style={{ marginBottom: '16px' }}>
              Save changes
            </button>
          </>
        )}

        <div className="detail-section">
          <label className="detail-label"><Users size={13} /> Share link (read-only)</label>
          <div className="share-row">
            <input className="input share-input" value={shareUrl} readOnly />
            <button className="btn-icon" onClick={copyLink} aria-label="Copy link">
              {copied ? <Check size={18} color="var(--color-success)" /> : <Copy size={18} />}
            </button>
          </div>
        </div>

        {isOwner && (
          showDelete ? (
            <div className="delete-confirm">
              <span>Delete this trip and all places?</span>
              <button className="btn-danger" onClick={onDelete}>Delete forever</button>
              <button className="btn-secondary" onClick={() => setShowDelete(false)}>Cancel</button>
            </div>
          ) : (
            <button className="btn-ghost btn-danger-ghost" onClick={() => setShowDelete(true)}>
              <Trash2 size={16} /> Delete trip
            </button>
          )
        )}
      </div>
    </div>
  );
}
