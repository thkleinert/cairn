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
// lone asterisk is an asterisk, and "****" is four asterisks. The precise
// guarantee is that the only characters the renderer ever removes are markers
// that found a partner — every other character of the note survives, in order,
// so a malformed marker degrades to something visible rather than to silent
// corruption or to text that has gone missing.
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
const TRAILING = '.,;:!?';

// The emphasis markers, which are deliberately NOT in TRAILING — see
// skipPastLink, which is the one place that needs them trimmed.
const MARKERS = '*~`';

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
 *
 * The first-character test is the gate both callers used to repeat: a link can
 * only begin 'h' or 'w', so the common position costs a char compare rather
 * than a regex attempt.
 */
function urlAt(text: string, i: number): string | null {
  const c = text[i];
  if (c !== 'h' && c !== 'H' && c !== 'w' && c !== 'W') return null;
  URL_PATTERN.lastIndex = i;
  const link = URL_PATTERN.exec(text);
  if (!link) return null;
  const url = trimTrailingPunctuation(link[0]);
  return URL_VALID.test(url) ? url : null;
}

/**
 * Where the code span opened at `i` ends, or null if it never closes.
 *
 * Both the scanner and the closer scan need this, and they must agree to the
 * character: the scan steps OVER a span that the scanner will later step INTO,
 * so a disagreement means one of them sees a marker the other has already
 * spoken for. Sharing the function is what makes that agreement structural
 * rather than a promise in a comment.
 */
function codeEnd(part: string, i: number): number | null {
  const end = part.indexOf('`', i + 1);
  // `end > i + 1` rejects an empty span, so "``" is two backticks.
  return end > i + 1 ? end : null;
}

/**
 * Length of the run of `ch` starting at `i`, counting no further than `max`.
 *
 * The cap is what keeps a long run of one marker from being quadratic.
 * openerAt is asked at every position of a run and only ever needs to know
 * "one, or two or more" — so without a cap, 80,000 asterisks measured the same
 * run 80,000 times and took 23 seconds, and 200,000 tildes took over two
 * minutes of blocked main thread on a note anyone can paste. findCloser needs
 * the true length and asks for it, but it consumes the whole run each time it
 * measures one, so there it is linear.
 */
function runLength(part: string, i: number, ch: string, max = Infinity): number {
  let run = 1;
  while (run < max && part[i + run] === ch) run += 1;
  return run;
}

/**
 * How far past a link the emphasis closer scan should jump.
 *
 * URL_PATTERN takes everything that isn't whitespace, so in
 * "*book www.example.com*" the link match swallows the closing marker, no
 * closer is found, and the span degrades to two literal asterisks around a
 * link. Stopping short of a trailing marker is what lets that closer be seen.
 *
 * The trim lives here rather than in trimTrailingPunctuation on purpose. A
 * note with no emphasis anywhere in it must go on rendering "www.example.com*"
 * exactly as it always has, marker and all: there is nothing for that marker
 * to pair with, and a silently shortened href is a broken link wearing a
 * working link's label — the pill only ever shows the host, so the user has no
 * way to see that it now points somewhere else.
 *
 * What this does NOT do is stop a link from absorbing a whole span that abuts
 * it with no space: "www.example.com*bold*" is one link with a garbled href,
 * exactly as it was before emphasis existed, because URL_PATTERN takes every
 * non-space character and nothing here second-guesses it. Left alone on
 * purpose — nobody writes a link and an emphasis run with no space between
 * them, and the case that people DO write, a link wrapped in emphasis, is the
 * one this function exists to make work.
 *
 * Cannot return 0, because a URL always begins with 'h' or 'w'.
 */
function skipPastLink(url: string): number {
  let end = url.length;
  while (MARKERS.includes(url[end - 1])) end -= 1;
  return end;
}

const EMPTY_MARKS: ReadonlySet<NoteMark> = new Set();

// Emphasis is parsed by re-entering the scanner, so a note is only ever as
// deep as its markers nest — three or four in anything a person writes. The
// cap exists for what a person PASTES: `parseNoteBody('*'.repeat(12000) + 'x'
// + '*'.repeat(12000))` overflows the stack without it, and since NoteBody
// renders inside the React tree, one such note takes the page down for every
// viewer of the trip rather than only its author. Past the cap markers simply
// stop being markers, which lands on the same answer everything else here
// gives when a marker cannot be honoured: it stays the character that was
// typed.
const MAX_DEPTH = 8;

function withMark(marks: ReadonlySet<NoteMark>, mark: NoteMark): ReadonlySet<NoteMark> {
  const next = new Set(marks);
  next.add(mark);
  return next;
}

// Anything that is neither a letter, a digit nor whitespace. Used only by the
// flanking rule below, where "is this a word character?" is the real question.
const PUNCT = /[^\p{L}\p{N}\s]/u;
const DIGIT = /\p{N}/u;

/**
 * Is this marker a multiplication sign rather than emphasis?
 *
 * Digits on both sides, which is how a trip note writes a room, a print size
 * or a screen: "Terrace 3*4 m", "Print 4*6 photos", "screen 1920*1080".
 * Without this the two markers in such a note pair with each other, an
 * asterisk the user typed disappears, and the text between them is emphasised
 * for no reason anyone can see.
 *
 * Both sides are required, so "*5*" still italicises a number and "a *2* b"
 * is untouched. Both ends of a note count as "not a digit", which is why the
 * check reads the characters rather than testing for undefined.
 *
 * This is deliberately narrower than "not inside a word". An earlier version
 * of this file rejected EVERY intraword marker, which is tidy in English and
 * removes inline emphasis outright from any script written without spaces:
 * "京都で*おすすめ*のスポット" and "在东京*必去*的地方" lost their emphasis
 * entirely, since in Japanese and Chinese every mid-sentence marker has a
 * letter before it. A travel planner's notes are exactly where someone writes
 * in the local language. Multiplication was the real hazard; letters were
 * collateral, and this is why CommonMark confines its own version of the rule
 * to punctuation.
 */
function digitFlanked(before: string | undefined, after: string | undefined): boolean {
  return before !== undefined && after !== undefined
    && DIGIT.test(before) && DIGIT.test(after);
}

/**
 * The emphasis this marker would open, or null if it opens nothing.
 *
 * Four rules, and all of them exist to keep ordinary prose ordinary:
 *
 * A marker must be followed by something that isn't whitespace. That single
 * condition is what keeps "2 * 3 = 6 * 2" arithmetic rather than an italic
 * " 3 = 6 " — without it any two asterisks in a line find each other. It is
 * also why "the answer is *" at the end of a line stays an asterisk.
 *
 * A marker followed by PUNCTUATION only opens if what precedes it is
 * whitespace, punctuation, or the start of the span being scanned —
 * CommonMark's left-flanking rule, and it earns its keep. Without it a stray
 * marker earlier in the line eats the emphasis the writer actually meant:
 *
 *     Bring adapters*, and *do not* forget  → "adapters, and *do not forget"
 *     Save as IMG*.jpg then *print* it      → "IMG.jpg then *print it"
 *
 * In both, the first asterisk pairs with the OPENING one of the real span, the
 * emphasis lands on text nobody wrote, and a character the user typed goes
 * missing. Requiring a boundary before a punctuation-facing marker says what a
 * writer means: "adapters*," is the tail of a word, "*do" starts something.
 *
 * A marker with digits on both sides never opens — see digitFlanked. That
 * closes the same hole for arithmetic, which reaches it through the digit door
 * rather than the punctuation one. findCloser applies the identical test, or
 * the bug simply swaps roles: "Take *lots of photos, room is 3*4 m" would let
 * a multiplication CLOSE a stray opener.
 *
 * '~' only counts in pairs. A single one is a tilde, which appears in prose
 * as "~20 minutes" far more often than it appears as an intended marker.
 */
function openerAt(part: string, i: number): { mark: NoteMark; width: number } | null {
  const c = part[i];
  if (c !== '*' && c !== '~') return null;
  // Two is all this needs to know — "one, or two or more" — and asking for no
  // more than that is what keeps a long run from costing a scan per position.
  const run = runLength(part, i, c, 2);
  // A run of two or more is "***both***": two characters open bold here and
  // the leftovers are handed back to the scanner, which reads them as the
  // italic opener they are.
  const width = c === '~' ? 2 : run;
  if (run < width) return null;
  const next = part[i + width];
  if (next === undefined || /\s/.test(next)) return null;
  // undefined means the start of the span being scanned, which is a boundary.
  const prev = part[i - 1];
  if (PUNCT.test(next) && prev !== undefined && !/\s/.test(prev) && !PUNCT.test(prev)) {
    return null;
  }
  if (digitFlanked(prev, next)) return null;
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
  // End of the link most recently stepped over, so the markers this scan hands
  // back off a link's tail can be read as CLOSERS but never as openers of
  // anything — `walk` keeps those characters inside the URL, and only this
  // scan ever sees them on their own. Without the distinction the two passes
  // disagree about where a code span is: in "*hi www.x.com` there* ok `q` end*"
  // this scan would take the link's trailing backtick for a code opener, skip
  // to the next backtick further down the note, and step straight over the
  // perfectly good closer after "there". Links cannot overlap, so one variable
  // is enough for a scan that only ever moves forwards.
  let linkTail = from;
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
    const url = urlAt(part, i);
    if (url) {
      linkTail = i + url.length;
      i += skipPastLink(url);
      continue;
    }
    // A code span is opaque for the same reason, and this scan has to know it
    // before `walk` does: without the step-over, "*price `2*3` here*" closes
    // the italic on the asterisk between the backticks, and the code span the
    // user asked for is gone — its backticks render as literal characters and
    // an emphasis run appears across a boundary nobody wrote.
    if (c === '`' && i >= linkTail) {
      const end = codeEnd(part, i);
      if (end !== null) { i = end + 1; continue; }
    }
    if (c !== ch) { i += 1; continue; }
    const run = runLength(part, i, ch);
    // `i > from` rejects an empty span, which is what makes "****" and "~~~~"
    // four and four characters of literal text rather than an empty <strong>.
    //
    // The digit test is openerAt's, mirrored. Without it the arithmetic bug
    // survives with the roles swapped — "Take *lots of photos, room is 3*4 m"
    // lets the multiplication CLOSE the stray opener, deleting an asterisk and
    // italicising twenty-five characters nobody asked for.
    if (i > from && !/\s/.test(part[i - 1]) && !digitFlanked(part[i - 1], part[i + run])) {
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
  const walk = (part: string, marks: ReadonlySet<NoteMark>, depth: number) => {
    let buffer = '';
    let i = 0;
    // Marker kinds ("*1", "**2", "~~2") already proven to have no partner
    // anywhere in `part`. Scoped to this call, since a different `part` is a
    // different question.
    const hopeless = new Set<string>();

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
      const c = part[i];
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

      // Code is the one span that does not re-enter the scanner: its contents
      // are the literal characters between the backticks, so `@Café Korb` is
      // an example of a mention rather than a mention, and `**` is two
      // asterisks. That is the whole point of having it.
      if (c === '`') {
        const close = codeEnd(part, i);
        if (close !== null) {
          flush();
          push({ type: 'text', value: part.slice(i + 1, close) }, withMark(marks, 'code'));
          i = close + 1;
          continue;
        }
      }

      const open = depth < MAX_DEPTH ? openerAt(part, i) : null;
      if (open) {
        // Every failed search costs a walk to the end of the string, so a line
        // dense in unpaired markers was quadratic: 'x' + '*y '.repeat(10000)
        // took 3.8 seconds, and 40000 took a minute of blocked main thread.
        // Bodies are unbounded text, the shared trip page renders bodies other
        // people wrote, and NoteBody parses on every render — so this is worth
        // not leaving to chance.
        //
        // One failure settles it for the rest of the string. A later opener of
        // the same kind searches a SUFFIX of the range that just came back
        // empty, and every test findCloser applies is positional — the run
        // width, the character before — so a range with no closer in it cannot
        // acquire one by being entered later.
        const key = `${c}${open.width}`;
        if (!hopeless.has(key)) {
          const close = findCloser(part, i + open.width, c, open.width);
          if (close !== null) {
            flush();
            walk(part.slice(i + open.width, close), withMark(marks, open.mark), depth + 1);
            i = close + open.width;
            continue;
          }
          hopeless.add(key);
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

  walk(text, EMPTY_MARKS, 0);
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
