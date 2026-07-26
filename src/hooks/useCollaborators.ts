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

export type InviteResult =
  | { status: 'added'; email: string; role: string }
  | { status: 'invited'; email: string; role: string; token: string };

export function useCollaborators(tripId: string) {
  const [members, setMembers] = useState<Collaborator[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [loading, setLoading] = useState(true);

  const loadMembers = useCallback(async () => {
    const { data } = await supabase.rpc('get_trip_members', { p_trip_id: tripId });
    setMembers((data as Collaborator[]) ?? []);
  }, [tripId]);

  // Not-yet-claimed invites, shown as pending rows. RLS lets trip members read
  // their trip's invites.
  const loadInvites = useCallback(async () => {
    const { data } = await supabase
      .from('trip_invites')
      .select('id, trip_id, email, role, token, created_at')
      .eq('trip_id', tripId)
      .is('accepted_at', null)
      .order('created_at', { ascending: true });
    setPendingInvites((data as PendingInvite[]) ?? []);
  }, [tripId]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadMembers(), loadInvites()]).finally(() => setLoading(false));
  }, [loadMembers, loadInvites]);

  // Invite by email: an existing account is added straight away; otherwise a
  // pending token invite is created and returned so the caller can build a
  // shareable link from it.
  const createInvite = async (email: string, role: 'editor' | 'viewer' = 'editor'): Promise<InviteResult> => {
    const { data, error } = await supabase.rpc('create_trip_invite', {
      p_trip_id: tripId,
      p_email: email,
      p_role: role,
    });
    if (error) throw error;
    const result = data as InviteResult;
    if (result.status === 'added') await loadMembers();
    else await loadInvites();
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

  return { members, pendingInvites, loading, createInvite, revokeInvite, removeCollaborator };
}
