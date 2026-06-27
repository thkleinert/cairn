import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const isConfigured =
  !!supabaseUrl &&
  !!supabaseAnonKey &&
  supabaseUrl.startsWith('http');

export const supabase = isConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null!;
