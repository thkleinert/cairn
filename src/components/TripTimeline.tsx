import { Plus, Minus, TriangleAlert } from 'lucide-react';
import { buildTimeline, formatVisit, formatRange, lastDay, baseYear } from '../lib/timeline';
import type { Place, PlaceVisit } from '../types';

interface Props {
  visits: PlaceVisit[];
  places: Place[];
  collapsed: boolean;
  onToggle: () => void;
  onSelectPlace: (placeId: string) => void;
}

// The trip read down the page in the order it happens, at the top of the
// outliner.
//
// It sits above the General section rather than in a screen of its own because
// it answers the question the outline cannot: the outline is sorted by name so
// things can be looked up, which is the right order for reading about a trip
// and the wrong one for reading a trip. Both orders on one page, and neither
// has to be a compromise.
//
// A place appears once per visit, not once per place — that is the whole point
// of visits being rows. A city you pass through twice is two lines here, with
// whatever happens in between sitting between them.
//
// Nothing is drawn when nothing is dated. An empty timeline heading on every
// trip would be furniture, and the way in is the place sheet rather than this.
export function TripTimeline({ visits, places, collapsed, onToggle, onSelectPlace }: Props) {
  const entries = buildTimeline(visits, places);
  if (entries.length === 0) return null;

  const year = baseYear(visits);
  // The furthest end reached, not the last row's end: a short stay nested
  // inside a long one is sorted after it, and reading the span off the last
  // row would report the trip as ending before it does.
  const spanEnd = entries.reduce(
    (furthest, e) => (lastDay(e.visit) > furthest ? lastDay(e.visit) : furthest),
    lastDay(entries[0].visit),
  );
  // Summed per visit rather than measured across the span, because the gaps
  // are nights spent somewhere this trip does not know about, and counting
  // them here would claim the trip accounts for time it doesn't.
  const totalNights = entries.reduce((sum, e) => sum + e.nights, 0);

  const nightsLabel = (n: number) =>
    n === 0 ? 'day trip' : `${n} night${n === 1 ? '' : 's'}`;

  // The .notes-group wrapper lives here rather than around the call site, so
  // that returning null above leaves nothing behind at all. Wrapped for the
  // same reason every other section on the page is: .notes-group and
  // .notes-block both set margin-bottom at equal specificity, and putting both
  // classes on one element lets the later rule win and swallows the gap.
  return (
    <div className="notes-group">
    <section className="notes-block timeline-block">
      <h2 className="notes-heading notes-heading--foldable">
        <span
          className={`note-bullet-dot notes-heading-dot ${collapsed ? 'note-bullet-dot--folded' : ''}`}
          aria-hidden="true"
        />
        {/* The whole line folds. Unlike a place heading there is nowhere for
            the words to lead and nothing to write here — the dates themselves
            are set on a place, which is the only thing that has them. */}
        <button
          type="button"
          className="notes-heading-link"
          aria-label={collapsed ? 'Expand the timeline' : 'Collapse the timeline'}
          onClick={onToggle}
        >
          <span className="notes-heading-name">Timeline</span>
        </button>
        {/* Inert here, where on a place heading it opens a bullet: there is
            nothing to write on a timeline. It stays for the layout — the fold
            has to land on the same axis as every other fold on the page. */}
        <span className="notes-heading-space" aria-hidden="true" />
        <button
          type="button"
          className="notes-fold"
          aria-label={collapsed ? 'Expand the timeline' : 'Collapse the timeline'}
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          {collapsed ? <Plus size={16} /> : <Minus size={16} />}
        </button>
      </h2>

      {/* What the fold is hiding, in the same place every other folded section
          on this page puts it. The span and the nights are the two things
          worth knowing without opening anything. */}
      {collapsed ? (
        <button type="button" className="notes-folded-hint" onClick={onToggle}>
          {formatRange(entries[0].visit.starts_on, spanEnd, year)}
          {totalNights > 0 ? ` · ${totalNights} night${totalNights === 1 ? '' : 's'}` : ''}
        </button>
      ) : (
        <ol className="timeline-list">
          {entries.map(entry => (
            <li key={entry.visit.id} className="timeline-item">
              {/* Time the trip does not account for, shown between the two
                  stays it falls between rather than as a property of either.
                  Not an error — a gap is usually a night on a train or a
                  stretch nobody has decided about yet — so it is drawn as a
                  quiet separator and not a warning. */}
              {entry.gapBefore > 0 && (
                <p className="timeline-gap">
                  {entry.gapBefore} day{entry.gapBefore === 1 ? '' : 's'} unaccounted for
                </p>
              )}

              <div className="timeline-row">
                <span className="timeline-dates">{formatVisit(entry.visit, year)}</span>
                <button
                  type="button"
                  className="timeline-place"
                  aria-label={`Open ${entry.place.name}`}
                  onClick={() => onSelectPlace(entry.place.id)}
                >
                  {entry.place.name}
                </button>
                <span className="timeline-nights">{nightsLabel(entry.nights)}</span>
              </div>

              {/* An overlap IS worth flagging: two stays claiming the same
                  night is a plan that cannot be carried out, and unlike a gap
                  there is no reading of it that is fine. Said on the later of
                  the two, which is the one that was moved. */}
              {entry.overlapsPrevious && (
                <p className="timeline-overlap">
                  <TriangleAlert size={13} />
                  Overlaps the stay before it
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
    </div>
  );
}
