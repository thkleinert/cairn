// persist-photo — copies a temporary Google Places photo into our own
// place-images bucket and returns the stable public URL.
//
//   POST /functions/v1/persist-photo   { photoUrl, path }
//
// The fetch has to happen server-side: Google's photo CDN sends no CORS
// headers, so a browser can't download the bytes itself. Everything else is
// deliberately the *caller's* privilege, not ours: the upload client is built
// from the caller's Authorization header (anon key + user JWT), so the
// bucket's storage RLS — INSERT only for editors of the trip in the path's
// first segment — decides whether the write is allowed. No service role, so a
// forged `path` can't land anywhere the caller couldn't already write.
//
// verify_jwt stays enabled for this function (see ../../config.toml): only
// signed-in users can invoke it at all.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

// Only Google photo hosts — this function must not be a general-purpose
// server-side fetch proxy (SSRF) for whatever URL a client sends.
function isAllowedPhotoHost(hostname: string): boolean {
  return /(^|\.)googleapis\.com$/.test(hostname) || /(^|\.)googleusercontent\.com$/.test(hostname);
}

// {trip_uuid}/… with a conservative charset; the storage policy re-checks the
// trip segment, this just refuses junk early (and '..' explicitly).
const SAFE_PATH =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9/_.-]{1,200}$/i;

const MAX_BYTES = 10 * 1024 * 1024; // matches the bucket's file_size_limit

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'missing authorization' }, 401);

  let photoUrl: string, path: string;
  try {
    const body = await req.json();
    photoUrl = String(body.photoUrl ?? '');
    path = String(body.path ?? '');
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  let parsed: URL;
  try {
    parsed = new URL(photoUrl);
  } catch {
    return json({ error: 'invalid photoUrl' }, 400);
  }
  if (parsed.protocol !== 'https:' || !isAllowedPhotoHost(parsed.hostname)) {
    return json({ error: 'photoUrl host not allowed' }, 400);
  }
  if (!SAFE_PATH.test(path) || path.includes('..')) {
    return json({ error: 'invalid path' }, 400);
  }

  // Download server-side (Google redirects to googleusercontent; follow).
  let res: Response;
  try {
    res = await fetch(photoUrl, { redirect: 'follow' });
  } catch {
    return json({ error: 'photo fetch failed' }, 502);
  }
  if (!res.ok) return json({ error: `photo fetch failed (${res.status})` }, 502);

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/')) {
    return json({ error: 'not an image' }, 400);
  }
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) return json({ error: 'image too large' }, 400);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) return json({ error: 'image too large' }, 400);

  // Upload as the caller — anon key + their JWT — so storage RLS applies.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { error: uploadErr } = await supabase.storage
    .from('place-images')
    .upload(path, bytes, { contentType, upsert: false });
  if (uploadErr) return json({ error: uploadErr.message }, 403);

  const { data } = supabase.storage.from('place-images').getPublicUrl(path);
  return json({ url: data.publicUrl });
});
