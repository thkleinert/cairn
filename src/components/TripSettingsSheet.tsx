import { useState } from 'react';
import { X, Trash2, UserPlus, UserX, Crown, Eye, Pencil, Plus, Copy, Check, Clock } from 'lucide-react';
import type { Trip } from '../types';
import { useCollaborators } from '../hooks/useCollaborators';
import { useSwipeToClose } from '../hooks/useSwipeToClose';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { QuickAddSheet } from './QuickAddSheet';
import { DateField } from './DateField';

interface Props {
  trip: Trip;
  userId: string;
  onClose: () => void;
  onUpdate: (updates: Partial<Trip>) => void;
  onDelete: () => void;
  onUploadCover: (file: File) => Promise<string | null>;
  isOwner: boolean;
}

const ROLE_ICONS: Record<string, React.ReactNode> = {
  owner: <Crown size={13} />,
  editor: <Pencil size={13} />,
  viewer: <Eye size={13} />,
};

export function TripSettingsSheet({ trip, onClose, onUpdate, onDelete, onUploadCover, isOwner }: Props) {
  const [name, setName] = useState(trip.name);
  const [startDate, setStartDate] = useState(trip.start_date ?? '');
  const [endDate, setEndDate] = useState(trip.end_date ?? '');
  const [coverImageUrl, setCoverImageUrl] = useState(trip.cover_image_url ?? '');
  const [showCoverSheet, setShowCoverSheet] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const { members, pendingInvites, createInvite, revokeInvite, removeCollaborator } = useCollaborators(trip.id);

  const inviteLinkFor = (token: string) => `${window.location.origin}/invite/${token}`;

  const copyLink = async (link: string, key: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(k => (k === key ? null : k)), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const handleRevoke = async (token: string) => {
    try { await revokeInvite(token); } catch { /* rare; leave the row */ }
  };
  const { sheetRef, handleProps } = useSwipeToClose(onClose);
  useEscapeClose(onClose);

  // Everything below auto-saves on change/blur — no separate Save button
  const handleNameBlur = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== trip.name) onUpdate({ name: trimmed });
    else setName(trip.name);
  };

  const handleStartDateChange = (value: string) => {
    setStartDate(value);
    onUpdate({ start_date: value || null });
  };

  const handleEndDateChange = (value: string) => {
    setEndDate(value);
    onUpdate({ end_date: value || null });
  };

  const handleSetCoverUrl = (url: string) => {
    setCoverImageUrl(url);
    onUpdate({ cover_image_url: url });
  };

  const handleUploadCover = async (files: FileList) => {
    const file = files[0];
    if (!file) return;
    const url = await onUploadCover(file);
    if (url) handleSetCoverUrl(url);
  };

  const handleRemoveCover = () => {
    setCoverImageUrl('');
    onUpdate({ cover_image_url: null });
  };

  const handleInvite = async () => {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviting(true);
    setInviteError('');
    setInviteSuccess('');
    setInviteLink('');
    try {
      const res = await createInvite(email, inviteRole);
      if (res.status === 'added') {
        setInviteSuccess(`${res.email} added as ${res.role}`);
      } else {
        // No account yet — surface a link the owner sends however they like.
        setInviteLink(inviteLinkFor(res.token));
        setInviteSuccess(`${res.email} has no account yet — share this link to invite them`);
      }
      setInviteEmail('');
    } catch (e) {
      // Supabase throws a PostgrestError (a plain object, not an Error), so
      // pull .message off either shape rather than falling back to a generic
      // string — the RPC's messages are what the user actually needs to see.
      const message =
        e instanceof Error ? e.message
        : typeof e === 'object' && e !== null && 'message' in e
          ? String((e as { message: unknown }).message)
          : 'Failed to invite';
      setInviteError(message);
    } finally {
      setInviting(false);
    }
  };

  const handleRemove = async (memberId: string, userIdToRemove: string) => {
    setRemovingId(memberId);
    try {
      await removeCollaborator(userIdToRemove);
    } catch (e) {
      console.error(e);
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="bottom-sheet-overlay" onClick={onClose}>
      <div
        className="bottom-sheet"
        ref={sheetRef}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Trip settings"
      >
        <div className="bottom-sheet-handle" {...handleProps} />
        <div className="sheet-header-row">
          <h2 className="bottom-sheet-title">Trip Settings</h2>
          <button className="sheet-close" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>

        {isOwner && (
          <>
            <div className="detail-section">
              <label className="detail-label">Name</label>
              <input className="input" value={name} onChange={e => setName(e.target.value)} onBlur={handleNameBlur} />
            </div>

            <div className="detail-section">
              <label className="detail-label">Dates</label>
              <div className="date-row">
                <DateField label="Start" value={startDate} onChange={handleStartDateChange} />
                <DateField label="End" value={endDate} onChange={handleEndDateChange} />
              </div>
            </div>

            <div className="detail-section">
              <label className="detail-label">Cover photo</label>
              {coverImageUrl ? (
                <div className="cover-box">
                  <img src={coverImageUrl} alt="" className="cover-box-image" onError={() => {}} />
                  <button
                    className="cover-box-action cover-box-action--edit"
                    onClick={() => setShowCoverSheet(true)}
                    aria-label="Change cover photo"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className="cover-box-action cover-box-action--remove"
                    onClick={handleRemoveCover}
                    aria-label="Remove cover photo"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ) : (
                <button
                  className="cover-box cover-box--empty"
                  onClick={() => setShowCoverSheet(true)}
                  aria-label="Add cover photo"
                >
                  <Plus size={22} />
                </button>
              )}
            </div>
          </>
        )}

        {/* Collaborators — invite by email with a role, no separate
            read-only link to manage */}
        <div className="detail-section">
          <label className="detail-label">Collaborators</label>

          <div className="collab-list">
            {members.map(m => (
              <div key={m.id} className="collab-row">
                <div className="collab-avatar">{m.email[0].toUpperCase()}</div>
                <div className="collab-info">
                  <span className="collab-email">{m.email}</span>
                  <span className="collab-role">
                    {ROLE_ICONS[m.role]}
                    {m.role}
                  </span>
                </div>
                {isOwner && m.role !== 'owner' && (
                  <button
                    className="btn-icon collab-remove"
                    onClick={() => handleRemove(m.id, m.user_id)}
                    disabled={removingId === m.id}
                    aria-label={`Remove ${m.email}`}
                  >
                    <UserX size={16} />
                  </button>
                )}
              </div>
            ))}

            {pendingInvites.map(inv => (
              <div key={inv.id} className="collab-row collab-row--pending">
                <div className="collab-avatar collab-avatar--pending"><Clock size={13} /></div>
                <div className="collab-info">
                  <span className="collab-email">{inv.email ?? 'Invite link'}</span>
                  <span className="collab-role">
                    {ROLE_ICONS[inv.role]}
                    {inv.role} · pending
                  </span>
                </div>
                <button
                  className="btn-icon"
                  onClick={() => copyLink(inviteLinkFor(inv.token), inv.token)}
                  aria-label="Copy invite link"
                >
                  {copiedKey === inv.token ? <Check size={16} /> : <Copy size={16} />}
                </button>
                {isOwner && (
                  <button
                    className="btn-icon collab-remove"
                    onClick={() => handleRevoke(inv.token)}
                    aria-label="Revoke invite"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            ))}
          </div>

          {isOwner && (
            <div className="collab-invite">
              <div className="collab-invite-inputs">
                <input
                  className="input"
                  type="email"
                  placeholder="Email address"
                  value={inviteEmail}
                  onChange={e => { setInviteEmail(e.target.value); setInviteError(''); setInviteSuccess(''); }}
                  onKeyDown={e => e.key === 'Enter' && handleInvite()}
                />
                <select
                  className="input collab-role-select"
                  value={inviteRole}
                  onChange={e => setInviteRole(e.target.value as 'editor' | 'viewer')}
                >
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
              </div>
              <button
                className="btn-secondary collab-invite-btn"
                onClick={handleInvite}
                disabled={inviting || !inviteEmail.trim()}
              >
                <UserPlus size={16} />
                {inviting ? 'Adding…' : 'Add'}
              </button>
              {inviteError && <p className="collab-error">{inviteError}</p>}
              {inviteSuccess && <p className="collab-success">{inviteSuccess}</p>}
              {inviteLink && (
                <div className="collab-invite-link">
                  <input
                    className="input"
                    readOnly
                    value={inviteLink}
                    onFocus={e => e.currentTarget.select()}
                  />
                  <button
                    type="button"
                    className="btn-secondary collab-copy-btn"
                    onClick={() => copyLink(inviteLink, 'new')}
                  >
                    {copiedKey === 'new' ? <Check size={16} /> : <Copy size={16} />}
                    {copiedKey === 'new' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {isOwner && (
          <div className="sheet-danger-zone">
            {showDelete ? (
              <div className="delete-confirm">
                <span>Delete this trip and all places?</span>
                <button className="btn-danger" onClick={onDelete}>Delete forever</button>
                <button className="btn-secondary" onClick={() => setShowDelete(false)}>Cancel</button>
              </div>
            ) : (
              <button className="btn-ghost btn-danger-ghost" onClick={() => setShowDelete(true)}>
                <Trash2 size={16} /> Delete trip
              </button>
            )}
          </div>
        )}
      </div>

      {showCoverSheet && (
        <QuickAddSheet
          title="Cover photo"
          onAddUrl={(url) => handleSetCoverUrl(url)}
          onUpload={handleUploadCover}
          onClose={() => setShowCoverSheet(false)}
        />
      )}
    </div>
  );
}
