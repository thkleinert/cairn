import { TAG_COLORS } from '../constants';

// Presenting collaborators. Cairn only ever knows someone's email — there are
// no display names — so both the label and the avatar tint are derived from it,
// and both must agree wherever a person appears (comment threads, the activity
// feed) or the same person looks like two different people.

export function authorName(email: string): string {
  return email.split('@')[0];
}

// Deterministic avatar tint per author, so each person keeps one colour
// across the thread — same idea as tag colours, hashed off the email.
export function avatarColor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) hash = (hash * 31 + email.charCodeAt(i)) | 0;
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length].value;
}
