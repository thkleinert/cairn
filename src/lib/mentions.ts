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
//
// Inline emphasis — *italic*, **bold**, ~~strike~~, `code` — is stored the
// same way, and inherits the same guarantee: an unmatched marker is not an
// error, it is the character the user typed. "2 * 3 = 6" is arithmetic, a
// lone asterisk is an asterisk, and "****" is four asterisks. Nothing here
// can turn a note into something that no longer reads as what was typed, so
// the textarea and the rendered row always agree about the text.
//
// Deliberately absent: _underscore_ emphasis, and every block-level construct
// (#, -, >). Underscores are load-bearing inside URLs and identifiers —
// "example.com/a_b_c", "snake_case" — and the notes ARE an outline, with the
// row's own depth carrying the structure, so a heading or a list marker inside
// one would be a second, contradictory hierarchy.

/** Emphasis in force over a segment. */
export type NoteMark = 'bold' | 'italic' | 'strike' | 'code';

export interface NoteSegment {
  type: 'text' | 'mention' | 'url';
  value: string;
  place?: Place;
  /** Set on 'url' segments: the value with a scheme guaranteed. */
  href?: string;
  /**
   * Emphasis wrapping this run, omitted when there is none.
   *
   * Flat rather than a tree, and a set rather than a single value, because
   * emphasis crosses the other two types instead of containing them: a bold
   * span holds text and @mentions and links alike, and "***x***" is one run
   * wearing two marks. A tree would make every consumer walk children to find
   * a mention; a mark set leaves the segment list exactly as flat as it was
   * and lets the renderer wrap whatever it was going to draw anyway.
   */
  marks?: ReadonlySet<NoteMark>;
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
// The emphasis markers are in here for the same reason, and they have to be:
// URL_PATTERN takes everything that isn't whitespace, so in "*book
// www.example.com*" the link swallows the closing '*', no closer is found, and
// the whole span degrades to literal asterisks around a link. A URL that
// genuinely ends in one of these characters is a price worth not paying for.
const TRAILING = '.,;:!?*~`';

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
 * The link starting exactly at `i`, or null. Shared by the two passes that
 * need to know where a URL ends: the one that emits it, and the emphasis
 * closer scan, which has to step over links rather than into them.
 */
function urlAt(text: string, i: number): string | null {
  URL_PATTERN.lastIndex = i;
  const link = URL_PATTERN.exec(text);
  if (!link) return null;
  const url = trimTrailingPunctuation(link[0]);
  return URL_VALID.test(url) ? url : null;
}

const EMPTY_MARKS: ReadonlySet<NoteMark> = new Set();

function withMark(marks: ReadonlySet<NoteMark>, mark: NoteMark): ReadonlySet<NoteMark> {
  const next = new Set(marks);
  next.add(mark);
  return next;
}

/**
 * The emphasis this marker would open, or null if it opens nothing.
 *
 * Two rules, and both exist to keep ordinary prose ordinary:
 *
 * A marker must be followed by something that isn't whitespace. That single
 * condition is what keeps "2 * 3 = 6 * 2" arithmetic rather than an italic
 * " 3 = 6 " — without it any two asterisks in a line find each other. It is
 * also why "the answer is *" at the end of a line stays an asterisk.
 *
 * '~' only counts in pairs. A single one is a tilde, which appears in prose
 * as "~20 minutes" far more often than it appears as an intended marker.
 */
function openerAt(part: string, i: number): { mark: NoteMark; width: number } | null {
  const c = part[i];
  if (c !== '*' && c !== '~') return null;
  let run = 1;
  while (part[i + run] === c) run += 1;
  // A run of three or more is "***both***": two characters open bold here and
  // the leftovers are handed back to the scanner, which reads them as the
  // italic opener they are.
  const width = c === '~' ? 2 : Math.min(run, 2);
  if (run < width) return null;
  const next = part[i + width];
  if (next === undefined || /\s/.test(next)) return null;
  return { mark: c === '~' ? 'strike' : width === 2 ? 'bold' : 'italic', width };
}

/**
 * Where the emphasis opened at `from - width` closes, or null if it never
 * does — in which case the caller leaves the opener as literal text.
 *
 * The mirror of the opener rule applies: a closer may not have whitespace
 * before it, so "*a* and * b" has one italic and one asterisk.
 *
 * Runs are measured rather than searched for character by character, because
 * a bare indexOf cannot tell "**" apart from "*". Scanning "*a **b** c*" for
 * the italic's partner has to walk past both halves of the bold and land on
 * the final asterisk; scanning "***x***" for the bold's partner finds no run
 * of exactly two and has to take the last two characters of the run of three,
 * leaving the odd one to close the italic inside it. Hence: an exact-width run
 * wins outright, and an over-long run is remembered as a fallback and consumed
 * from its END, since the marks that close last are the ones that opened first.
 */
function findCloser(part: string, from: number, ch: string, width: number): number | null {
  let fallback: number | null = null;
  let i = from;
  while (i < part.length) {
    const c = part[i];
    // A link's interior is opaque to emphasis, exactly as it is to mentions.
    // Without this step-over, "2*3 and http://x.example/*a/b" closes the
    // italic on the asterisk in the path, and the link is cut in half.
    //
    // The one marker that CAN still close is one sitting at a link's very
    // end, because trimTrailingPunctuation has already handed it back — a
    // trailing '*' is treated as the sentence's, the same way a trailing '.'
    // always has been. That is what makes "*book www.example.com*" italic
    // prose around a whole link rather than two literal asterisks.
    if (c === 'h' || c === 'H' || c === 'w' || c === 'W') {
      const url = urlAt(part, i);
      if (url) { i += url.length; continue; }
    }
    if (c !== ch) { i += 1; continue; }
    let run = 1;
    while (part[i + run] === ch) run += 1;
    // `i > from` rejects an empty span, which is what makes "****" and "~~~~"
    // four and four characters of literal text rather than an empty <strong>.
    if (i > from && !/\s/.test(part[i - 1])) {
      if (run === width) return i;
      if (run > width && fallback === null) fallback = i + run - width;
    }
    i += run;
  }
  return fallback;
}

/**
 * Split note text into plain runs, resolved @mentions, links, and emphasis.
 * An `@` whose following text matches no place stays plain text, and so does
 * any emphasis marker that never finds its partner.
 */
export function parseNoteBody(text: string, places: Place[]): NoteSegment[] {
  if (!text) return [];
  const ordered = byMatchPriority(places);
  const segments: NoteSegment[] = [];

  const push = (seg: NoteSegment, marks: ReadonlySet<NoteMark>) => {
    if (marks.size > 0) seg.marks = marks;
    segments.push(seg);
  };

  // Emphasis is handled by re-entering the scanner on the span's contents, so
  // a bold run is parsed for mentions and links like any other text. What
  // comes back out is still one flat list — the recursion only accumulates
  // marks, it never nests segments.
  const walk = (part: string, marks: ReadonlySet<NoteMark>) => {
    let buffer = '';
    let i = 0;

    const flush = () => {
      if (buffer) { push({ type: 'text', value: buffer }, marks); buffer = ''; }
    };

    while (i < part.length) {
      // Links are tested first so an '@' inside one (a userinfo prefix, a query
      // parameter) can't split the URL in half by starting a mention mid-link.
      // Emphasis is tested after this branch for the identical reason, and the
      // hazard is worse there because URLs are full of markers: without this
      // ordering "www.example.com/a*b*c" loses its middle to an <em> and stops
      // being one link. (Underscores would be the common case, which is why
      // _emphasis_ is not supported at all — see the note at the top.)
      // Gated on the only two characters a link can start with, so the common
      // case is a char compare rather than a regex attempt per position.
      const c = part[i];
      if (c === 'h' || c === 'H' || c === 'w' || c === 'W') {
        const url = urlAt(part, i);
        if (url) {
          flush();
          push({
            type: 'url',
            value: url,
            href: /^https?:\/\//i.test(url) ? url : `https://${url}`,
          }, marks);
          i += url.length;
          continue;
        }
      }

      // Code is the one span that does not re-enter the scanner: its contents
      // are the literal characters between the backticks, so `@Café Korb` is
      // an example of a mention rather than a mention, and `**` is two
      // asterisks. That is the whole point of having it.
      if (c === '`') {
        const close = part.indexOf('`', i + 1);
        if (close > i + 1) {
          flush();
          push({ type: 'text', value: part.slice(i + 1, close) }, withMark(marks, 'code'));
          i = close + 1;
          continue;
        }
      }

      const open = openerAt(part, i);
      if (open) {
        const close = findCloser(part, i + open.width, c, open.width);
        if (close !== null) {
          flush();
          walk(part.slice(i + open.width, close), withMark(marks, open.mark));
          i = close + open.width;
          continue;
        }
        // No partner: fall through and let the marker land in the buffer as
        // the character it is.
      }

      if (c !== '@') { buffer += c; i += 1; continue; }

      const rest = part.slice(i + 1);
      const hit = ordered.find(p =>
        p.name.length > 0 && rest.slice(0, p.name.length).toLowerCase() === p.name.toLowerCase()
      );
      if (!hit) { buffer += c; i += 1; continue; }

      flush();
      // Echo the note's own casing rather than the place's, so the text the user
      // typed is what they see.
      push({ type: 'mention', value: rest.slice(0, hit.name.length), place: hit }, marks);
      i += 1 + hit.name.length;
    }

    flush();
  };

  walk(text, EMPTY_MARKS);
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
