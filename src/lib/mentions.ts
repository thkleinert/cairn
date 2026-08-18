import type { Place } from '../types';

// What a note body carries beyond plain text: @-mentions of places, and links.
// Both are stored literally and recognised at render time — nothing in the
// database is a token, so a note always reads as what was typed.
//
// Mentions are stored as plain text — the note holds literally "@Café Korb",
// not an id —
// and resolved against the trip's current places at render time. The tradeoff
// is deliberate: the textarea stays something a human can read and edit on a
// phone, with no rich-text dependency, and a mention that stops resolving
// degrades to ordinary text rather than to a broken token. The cost is that
// renaming a place unlinks mentions of its old name, and two places sharing a
// name both resolve to the first. Both are visible to the user rather than
// silent corruption, which is the right way round for a notes field.

export interface NoteSegment {
  type: 'text' | 'mention' | 'url';
  value: string;
  place?: Place;
  /** Set on 'url' segments: the value with a scheme guaranteed. */
  href?: string;
}

// Only an explicit scheme or a leading "www." counts as a link. A bare
// "example.com" rule would turn "Closed Mondays.Book ahead" — a missing space
// after a full stop — into a link, and a note is prose first.
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"']+/iy;

// Re-checked after trailing punctuation is trimmed, so that what's left is
// still a link rather than the remains of one — "www.." must not become a
// pill labelled "www".
const URL_VALID = /^(?:https?:\/\/[^\s<>"']+|www\.[^\s<>"'.]+\.[^\s<>"']+)$/i;

// Sentence punctuation that follows a URL far more often than it ends one.
const TRAILING = '.,;:!?';

/**
 * Trim what a writer's sentence contributed rather than the URL.
 * Parentheses are balanced rather than stripped outright, because Wikipedia
 * and Maps links carry them legitimately — "…/wiki/Vienna_(state)".
 */
function trimTrailingPunctuation(url: string): string {
  let end = url.length;
  for (;;) {
    while (end > 0 && TRAILING.includes(url[end - 1])) end -= 1;
    if (end > 0 && url[end - 1] === ')') {
      const slice = url.slice(0, end);
      const opens = slice.split('(').length - 1;
      const closes = slice.split(')').length - 1;
      if (closes > opens) { end -= 1; continue; }
    }
    return url.slice(0, end);
  }
}

/** What a link is labelled with: its host, which is the part worth reading. */
export function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
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
 * Split note text into plain runs, resolved @mentions, and links.
 * An `@` whose following text matches no place stays plain text.
 */
export function parseNoteBody(text: string, places: Place[]): NoteSegment[] {
  if (!text) return [];
  const ordered = byMatchPriority(places);
  const segments: NoteSegment[] = [];
  let buffer = '';
  let i = 0;

  const flush = () => {
    if (buffer) { segments.push({ type: 'text', value: buffer }); buffer = ''; }
  };

  while (i < text.length) {
    // Links are tested first so an '@' inside one (a userinfo prefix, a query
    // parameter) can't split the URL in half by starting a mention mid-link.
    // Gated on the only two characters a link can start with, so the common
    // case is a char compare rather than a regex attempt per position.
    const c = text[i];
    if (c === 'h' || c === 'H' || c === 'w' || c === 'W') {
      URL_PATTERN.lastIndex = i;
      const link = URL_PATTERN.exec(text);
      if (link) {
        const url = trimTrailingPunctuation(link[0]);
        if (URL_VALID.test(url)) {
          flush();
          segments.push({
            type: 'url',
            value: url,
            href: /^https?:\/\//i.test(url) ? url : `https://${url}`,
          });
          i += url.length;
          continue;
        }
      }
    }

    if (c !== '@') { buffer += c; i += 1; continue; }

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
