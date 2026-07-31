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

// 'invited' — a new account was provisioned; the link signs them in and
//              lands on the password-setup step.
// 'existing' — the email already has an account; the link is redeemed once
//              they're signed in.
export type InviteResult = {
  status: 'invited' | 'existing';
  email: string;
  role: string;
  link: string;
};

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

  // Invite by email. Goes through the invite-collaborator edge function,
  // which creates the pending invite row *and* provisions an account for a
  // first-time invitee — that's what lets the instance keep self-service
  // sign-up switched off. Either way the owner gets back a link to share;
  // nobody is added to a trip without opening it themselves.
  const createInvite = async (email: string, role: 'editor' | 'viewer' = 'editor'): Promise<InviteResult> => {
    const { data, error: fnError } = await supabase.functions.invoke<InviteResult & { error?: string }>(
      'invite-collaborator',
      { body: { tripId, email, role, origin: window.location.origin } },
    );
    // A non-2xx from an edge function surfaces as FunctionsHttpError with the
    // body unread, so dig the real message out rather than showing the
    // generic "Edge Function returned a non-2xx status code".
    if (fnError) {
      const ctx = (fnError as { context?: Response }).context;
      let message = fnError.message;
      if (ctx && typeof ctx.json === 'function') {
        try {
          const body = await ctx.json();
          if (body?.error) message = body.error;
        } catch { /* keep the generic message */ }
      }
      throw new Error(message);
    }
    if (!data || data.error) throw new Error(data?.error ?? 'Could not create the invite');
    await loadInvites();
    return data;
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
