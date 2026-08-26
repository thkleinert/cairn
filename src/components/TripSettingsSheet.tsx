import { useState, useEffect } from 'react';
import { X, Trash2, UserPlus, UserX, Crown, Eye, Pencil, Plus, Copy, Check, Clock, Link2, RefreshCw } from 'lucide-react';
import type { Trip } from '../types';
import { supabase } from '../lib/supabase';
import { toast } from '../lib/toast';
import { cleanupReplacedCover } from '../lib/trips';
import { useCollaborators } from '../hooks/useCollaborators';
import { useSwipeToClose } from '../hooks/useSwipeToClose';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { QuickAddSheet } from './QuickAddSheet';
import { DateRangeField } from './DateRangeField';
import type { DateRange } from './DateRangeSheet';

interface Props {
  trip: Trip;
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
  const [shareLink, setShareLink] = useState('');
  const [rotating, setRotating] = useState(false);

  const { members, pendingInvites, error: membersError, createInvite, revokeInvite, removeCollaborator } =
    useCollaborators(trip.id);

  // Pending-invite rows only ever show the plain link: the one-time action
  // link that provisions an account is returned once, at creation, and can't
  // be reconstructed later. Someone who never redeemed it can still use this
  // one — they'll be asked to sign in, or the owner can re-invite them.
  const inviteLinkFor = (token: string) => `${window.location.origin}/invite/${token}`;

  // The share token is owner-only and never part of the trip row the client
  // holds (it's a bearer credential) — fetched on demand via RPC.
  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    supabase.rpc('get_share_token', { p_trip_id: trip.id }).then(({ data }) => {
      if (!cancelled && data) setShareLink(`${window.location.origin}/shared/${data}`);
    });
    return () => { cancelled = true; };
  }, [isOwner, trip.id]);

  // Rotate = the remedy when a share link leaked; old links die immediately.
  const handleRotateShareLink = async () => {
    if (rotating) return;
    setRotating(true);
    const { data, error } = await supabase.rpc('rotate_share_token', { p_trip_id: trip.id });
    if (!error && data) setShareLink(`${window.location.origin}/shared/${data}`);
    setRotating(false);
  };

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

  /**
   * Both ends in one write, because they are now chosen together.
   *
   * This was two handlers writing two columns independently, which is how a
   * trip could end up with an end date and no start — the create form would
   * take one without the other, and nothing here objected. Neither surface can
   * produce that any more, since both now write the pair or neither.
   *
   * A row already in that state is NOT repaired on sight: this writes only
   * when someone picks or clears a range, and the field above shows such a
   * trip as undated until they do. Normalising it on open would be a write
   * nobody asked for, against data this sheet was only opened to look at.
   */
  const handleDatesChange = (range: DateRange | null) => {
    setStartDate(range?.start ?? '');
    setEndDate(range?.end ?? '');
    onUpdate({ start_date: range?.start ?? null, end_date: range?.end ?? null });
  };

  const handleSetCoverUrl = (url: string) => {
    // A replaced cover that lived in our public bucket would otherwise stay
    // world-readable forever.
    if (coverImageUrl && coverImageUrl !== url) cleanupReplacedCover(coverImageUrl);
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
    if (coverImageUrl) cleanupReplacedCover(coverImageUrl);
    setCoverImageUrl('');
    onUpdate({ cover_image_url: null });
  };

  // Guarded inside the handler, not just on the button: Enter in the email
  // input calls this directly, and repeat presses during the await would
  // create the invite twice.
  const handleInvite = async () => {
    const email = inviteEmail.trim();
    if (!email || inviting) return;
    setInviting(true);
    setInviteError('');
    setInviteSuccess('');
    setInviteLink('');
    try {
      // Always a link — nobody is added to a trip without opening it. A
      // first-time invitee gets an account provisioned along the way, so the
      // link also signs them in and asks them to pick a password.
      const res = await createInvite(email, inviteRole);
      setInviteLink(res.link);
      setInviteSuccess(
        res.status === 'invited'
          ? `Send this link to ${res.email} — it sets up their account and joins them as ${res.role}`
          : `${res.email} already has an account — send this link to join them as ${res.role}`
      );
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
    } catch {
      // Every other failure path in the app toasts; a console-only error left
      // the row sitting there with no explanation.
      toast('Could not remove collaborator');
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
              {/* A trip may legitimately have no dates at all, so this one
                  clears; a visit cannot, so that one does not. */}
              <DateRangeField
                label="Dates"
                title="When is this trip?"
                value={startDate ? { start: startDate, end: endDate || null } : null}
                onChange={handleDatesChange}
                year={new Date().getFullYear()}
                clearable
              />
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

        {isOwner && shareLink && (
          <div className="detail-section">
            <label className="detail-label">Share (read-only link)</label>
            <p className="detail-hint">
              Anyone with this link can view the trip — no account needed.
              Reset it to cut off old links.
            </p>
            <div className="collab-invite-link">
              <input
                className="input"
                readOnly
                value={shareLink}
                onFocus={e => e.currentTarget.select()}
              />
              <button
                type="button"
                className="btn-secondary collab-copy-btn"
                onClick={() => copyLink(shareLink, 'share')}
              >
                {copiedKey === 'share' ? <Check size={16} /> : <Link2 size={16} />}
                {copiedKey === 'share' ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                className="btn-icon"
                onClick={handleRotateShareLink}
                disabled={rotating}
                aria-label="Reset share link"
                title="Reset share link"
              >
                <RefreshCw size={16} />
              </button>
            </div>
          </div>
        )}

        {/* Collaborators — invite by email with a role; every invite is a
            copyable link, redeemed by whoever opens it */}
        <div className="detail-section">
          <label className="detail-label">Collaborators</label>

          {membersError && (
            <p className="collab-error">Couldn't load collaborators — check your connection and reopen.</p>
          )}

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
                  onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && handleInvite()}
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
