// Reading a database refusal back to the person who caused it.
//
// Several of the rules in this schema live in triggers rather than check
// constraints, because a check cannot look at another row: only a stop can
// have dates, only a stop can hold spots, a dated stop cannot quietly become a
// spot. Each of those raises a sentence written to be read —
//
//     Remove this place's dates before making it a spot
//
// — and every one of them was being replaced at the client with "Could not
// save changes", which tells the user that something is wrong but not what,
// and leaves the one control that would fix it unmentioned.
//
// The catch is that Postgres's OWN check violations arrive as the same
// SQLSTATE, and they say things like
//
//     new row for relation "place_visits" violates check constraint
//     "place_visits_dates_ordered"
//
// which is a sentence about the schema, not about the trip. So the code alone
// cannot decide whether a message is fit to show. That prefix can: Postgres
// generates it verbatim, and no trigger here starts a message that way.
//
// Verified against the live project rather than assumed — all three guards
// raise 23514, with the trigger messages coming through intact and the
// ordering constraint coming through in the generated form above.

/** PostgREST's shape for a failed request. */
interface PostgrestError {
  code?: string;
  message?: string;
}

/** Postgres's own wording for a violated check constraint. */
const GENERATED = /^new row for relation "/;

/**
 * The message to show for a failed write, or null when there is nothing
 * worth showing and the caller should use its own wording.
 */
export function guardMessage(error: PostgrestError | null): string | null {
  if (!error || error.code !== '23514') return null;
  const message = error.message?.trim();
  if (!message || GENERATED.test(message)) return null;
  return message;
}
