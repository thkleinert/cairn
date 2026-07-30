import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

// The recovery gate must survive a reload: the emailed reset link grants a
// full session, and if the flag lived only in React state, reloading the
// reset page would drop the UpdatePasswordScreen and land straight in the
// account without ever changing the password. sessionStorage keeps the gate
// up for this tab until the password is actually updated.
const RECOVERY_KEY = 'cairn.passwordRecovery';

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [passwordRecovery, setPasswordRecovery] = useState(
    () => sessionStorage.getItem(RECOVERY_KEY) === '1'
  );

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      if (event === 'PASSWORD_RECOVERY') {
        sessionStorage.setItem(RECOVERY_KEY, '1');
        setPasswordRecovery(true);
      }
      if (event === 'SIGNED_OUT') {
        sessionStorage.removeItem(RECOVERY_KEY);
        setPasswordRecovery(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const signIn = (email: string, password: string) =>
    supabase.auth.signInWithPassword({ email, password });

  const signUp = (email: string, password: string) =>
    supabase.auth.signUp({ email, password });

  const signOut = () => supabase.auth.signOut();

  const resetPassword = (email: string) =>
    supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });

  const updatePassword = async (password: string) => {
    const result = await supabase.auth.updateUser({ password });
    if (!result.error) {
      sessionStorage.removeItem(RECOVERY_KEY);
      setPasswordRecovery(false);
      // The user resetting their password is usually trying to lock a
      // stolen/shared session out — kill every session except this one.
      await supabase.auth.signOut({ scope: 'others' }).catch(() => {});
    }
    return result;
  };

  return { user, loading, signIn, signUp, signOut, resetPassword, updatePassword, passwordRecovery };
}
