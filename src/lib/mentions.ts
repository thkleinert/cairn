import type { Place } from '../types';

// @-mentions of places inside trip notes.
//
// Stored as plain text — the note holds literally "@Café Korb", not an id —
// and resolved against the trip's current places at render time. The tradeoff
// is deliberate: the textarea stays something a human can read and edit on a
// phone, with no rich-text dependency, and a mention that stops resolving
// degrades to ordinary text rather than to a broken token. The cost is that
// renaming a place unlinks mentions of its old name, and two places sharing a
// name both resolve to the first. Both are visible to the user rather than
// silent corruption, which is the right way round for a notes field.

export interface MentionSegment {
  type: 'text' | 'mention';
  value: string;
  place?: Place;
}

// Longest-first so "Hotel Wandl" wins over a hypothetical "Hotel", and a
// mention of the longer name isn't truncated into the shorter one plus stray
// text. Ties broken alphabetically purely for determinism.
function byMatchPriority(places: Place[]): Place[] {
  return [...places].sort((a, b) =>
    b.name.length - a.name.length || a.name.localeCompare(b.name)
  );
}

/**
 * Split note text into plain runs and resolved @mentions.
 * An `@` whose following text matches no place stays plain text.
 */
export function parseMentions(text: string, places: Place[]): MentionSegment[] {
  if (!text) return [];
  const ordered = byMatchPriority(places);
  const segments: MentionSegment[] = [];
  let buffer = '';
  let i = 0;

  const flush = () => {
    if (buffer) { segments.push({ type: 'text', value: buffer }); buffer = ''; }
  };

  while (i < text.length) {
    if (text[i] !== '@') { buffer += text[i]; i += 1; continue; }

    const rest = text.slice(i + 1);
    const hit = ordered.find(p =>
      p.name.length > 0 && rest.slice(0, p.name.length).toLowerCase() === p.name.toLowerCase()
    );
    if (!hit) { buffer += text[i]; i += 1; continue; }

    flush();
    // Echo the note's own casing rather than the place's, so the text the user
    // typed is what they see.
    segments.push({ type: 'mention', value: rest.slice(0, hit.name.length), place: hit });
    i += 1 + hit.name.length;
  }

  flush();
  return segments;
}

export interface MentionQuery {
  /** Index of the triggering '@'. */
  at: number;
  /** Text typed between the '@' and the caret. */
  query: string;
}

// A mention is being typed when there's an '@' before the caret on the same
// line with no intervening '@'. Place names contain spaces ("Café Korb"), so
// the query may too — the caller closes the popup once nothing matches, which
// is what stops an ordinary "@" in prose from hijacking the rest of a line.
const MAX_QUERY = 40;

export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at === -1) return null;
  const query = upto.slice(at + 1);
  if (query.length > MAX_QUERY) return null;
  if (query.includes('\n') || query.includes('@')) return null;
  return { at, query };
}

export function matchPlaces(places: Place[], query: string, limit = 6): Place[] {
  const q = query.trim().toLowerCase();
  const ordered = q
    ? places.filter(p => p.name.toLowerCase().includes(q))
    : [...places];
  // Prefix matches first — typing "ho" should surface "Hotel Wandl" above
  // "Grand Hotel", which merely contains it.
  ordered.sort((a, b) => {
    const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
    const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
    return ap - bp || a.name.localeCompare(b.name);
  });
  return ordered.slice(0, limit);
}

/** Replace the in-progress query with the chosen place's name. */
export function applyMention(
  text: string, mention: MentionQuery, place: Place, caret: number
): { text: string; caret: number } {
  const inserted = `@${place.name} `;
  const next = text.slice(0, mention.at) + inserted + text.slice(caret);
  return { text: next, caret: mention.at + inserted.length };
}
