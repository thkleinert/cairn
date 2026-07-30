import { supabase } from './supabase';

// The bucket is public: anyone holding a file's URL can fetch its bytes
// forever. So "removing" a photo must also remove the object, not just the
// DB row that pointed at it — otherwise deleted images stay world-readable
// indefinitely. All removals here are best-effort: an orphaned file is a
// cleanup problem, never a reason to fail the user action that triggered it.

const BUCKET = 'place-images';
const PUBLIC_MARKER = `/storage/v1/object/public/${BUCKET}/`;

// Our own bucket URL → storage path; null for external URLs (pasted links,
// Google photos) which are not ours to delete.
export function storagePathFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const i = url.indexOf(PUBLIC_MARKER);
  if (i === -1) return null;
  return decodeURIComponent(url.slice(i + PUBLIC_MARKER.length).split('?')[0]);
}

export async function removeStorageUrls(urls: Array<string | null | undefined>): Promise<void> {
  const paths = urls.map(storagePathFromUrl).filter((p): p is string => p !== null);
  if (paths.length === 0) return;
  try {
    await supabase.storage.from(BUCKET).remove(paths);
  } catch { /* best-effort */ }
}

// Everything stored under a trip: {trip}/cover-… and {trip}/{place}/… .
// Must run BEFORE the trip row is deleted — the storage DELETE policy checks
// trip editorship via the path's first segment, which stops existing the
// moment the trip row (and the caller's membership) is gone.
export async function removeTripStorage(tripId: string): Promise<void> {
  try {
    const { data: top } = await supabase.storage.from(BUCKET).list(tripId, { limit: 1000 });
    const files: string[] = [];
    const folders: string[] = [];
    for (const entry of top ?? []) {
      // list() marks real files with an id; folders come back without one.
      if (entry.id) files.push(`${tripId}/${entry.name}`);
      else folders.push(entry.name);
    }
    for (const folder of folders) {
      const { data: sub } = await supabase.storage.from(BUCKET).list(`${tripId}/${folder}`, { limit: 1000 });
      for (const entry of sub ?? []) {
        if (entry.id) files.push(`${tripId}/${folder}/${entry.name}`);
      }
    }
    if (files.length > 0) await supabase.storage.from(BUCKET).remove(files);
  } catch { /* best-effort */ }
}
