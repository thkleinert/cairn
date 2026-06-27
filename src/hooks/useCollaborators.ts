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

export function useCollaborators(tripId: string) {
  const [members, setMembers] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.rpc('get_trip_members', { p_trip_id: tripId });
    setMembers((data as Collaborator[]) ?? []);
    setLoading(false);
  }, [tripId]);

  useEffect(() => { load(); }, [load]);

  const inviteCollaborator = async (email: string, role: 'editor' | 'viewer' = 'editor') => {
    const { data, error } = await supabase.rpc('invite_collaborator', {
      p_trip_id: tripId,
      p_email: email,
      p_role: role,
    });
    if (error) throw error;
    const newMember = Array.isArray(data) ? data[0] : data;
    if (newMember) {
      setMembers(prev => {
        const existing = prev.findIndex(m => m.user_id === newMember.user_id);
        if (existing >= 0) {
          return prev.map((m, i) => (i === existing ? newMember : m));
        }
        return [...prev, newMember];
      });
    }
    return newMember as Collaborator;
  };

  const removeCollaborator = async (userId: string) => {
    const { error } = await supabase.rpc('remove_collaborator', {
      p_trip_id: tripId,
      p_user_id: userId,
    });
    if (error) throw error;
    setMembers(prev => prev.filter(m => m.user_id !== userId));
  };

  return { members, loading, inviteCollaborator, removeCollaborator };
}
