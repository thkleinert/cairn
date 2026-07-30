import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';

export interface Collaborator {
  id: string;
  trip_id: string;
  user_id: string;
  role: string;
  joined_at: string;
  email: string;
}

export interface PendingInvite {
  id: string;
  trip_id: string;
  email: string | null;
  role: string;
  token: string;
  created_at: string;
}

export type InviteResult = { status: 'invited'; email: string; role: string; token: string };

export function useCollaborators(tripId: string) {
  const [members, setMembers] = useState<Collaborator[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [loading, setLoading] = useState(true);
  // A transient failure must not render as an empty member list — to an
  // owner that reads as "all my collaborators were removed".
  const [error, setError] = useState(false);

  const loadMembers = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('get_trip_members', { p_trip_id: tripId });
    if (rpcError) { setError(true); return; }
    setMembers((data as Collaborator[]) ?? []);
  }, [tripId]);

  // Not-yet-claimed invites, shown as pending rows. The trip_invites SELECT
  // policy is owner-only (tokens are bearer credentials), so non-owners get
  // an empty list here — fine, the invite UI is owner-gated anyway.
  const loadInvites = useCallback(async () => {
    const { data, error: selectError } = await supabase
      .from('trip_invites')
      .select('id, trip_id, email, role, token, created_at')
      .eq('trip_id', tripId)
      .is('accepted_at', null)
      .order('created_at', { ascending: true });
    if (selectError) { setError(true); return; }
    setPendingInvites((data as PendingInvite[]) ?? []);
  }, [tripId]);

  useEffect(() => {
    setLoading(true);
    setError(false);
    Promise.all([loadMembers(), loadInvites()]).finally(() => setLoading(false));
  }, [loadMembers, loadInvites]);

  // Invite by email: always a pending token invite — the RPC never adds
  // anyone directly (no membership without opening the link, and no
  // "does this email have an account" oracle).
  const createInvite = async (email: string, role: 'editor' | 'viewer' = 'editor'): Promise<InviteResult> => {
    const { data, error: rpcError } = await supabase.rpc('create_trip_invite', {
      p_trip_id: tripId,
      p_email: email,
      p_role: role,
    });
    if (rpcError) throw rpcError;
    const result = data as InviteResult;
    await loadInvites();
    return result;
  };

  const revokeInvite = async (token: string) => {
    const { error } = await supabase.rpc('revoke_trip_invite', { p_token: token });
    if (error) throw error;
    setPendingInvites(prev => prev.filter(i => i.token !== token));
  };

  const removeCollaborator = async (userId: string) => {
    const { error } = await supabase.rpc('remove_collaborator', {
      p_trip_id: tripId,
      p_user_id: userId,
    });
    if (error) throw error;
    setMembers(prev => prev.filter(m => m.user_id !== userId));
  };

  return { members, pendingInvites, loading, error, createInvite, revokeInvite, removeCollaborator };
}
