import { useState, useEffect, useRef, lazy } from 'react';
import { MapBoundary } from './MapBoundary';
import { ArrowLeft, Tag as TagIcon, Settings, List, Map, Plus, NotebookPen, Eye, EyeOff } from 'lucide-react';
import type { PickedPoint, Place, Trip } from '../types';
import { usePlaces } from '../hooks/usePlaces';
import { useTripNotes } from '../hooks/useTripNotes';
import { usePlaceVisits } from '../hooks/usePlaceVisits';
import { useTags } from '../hooks/useTags';
import { useFoldState } from '../hooks/useFoldState';
import { usePersistentSet } from '../hooks/usePersistentSet';
import { updateTrip, deleteTrip, uploadTripCover } from '../lib/trips';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { useHistoryLayer } from '../hooks/useHistoryLayer';
// Lazy: mapbox-gl is ~90% of the bundle; splitting it means the auth screen,
// trip list, and invite/share landings load without it. The map chunk starts
// fetching the moment a trip opens.
const MapView = lazy(() => import('./MapView').then(m => ({ default: m.MapView })));
import { PlaceSearch } from './PlaceSearch';
import { MapPickSheet } from './MapPickSheet';
import { TripNotesPage } from './TripNotesPage';
import { PlaceDetailSheet } from './PlaceDetailSheet';
import { TagFilterSheet } from './TagFilterSheet';
import { TripSettingsSheet } from './TripSettingsSheet';
import { PlaceListView } from './PlaceListView';

interface Props {
  trip: Trip;
  userId: string;
  onBack: () => void;
  // Settings edits save here; App owns the trip object, so it must be told
  // about updates or the topbar/settings keep rendering the stale trip.
  onTripUpdated: (trip: Trip) => void;
  // Optional deep-link target — e.g. jumping in from an activity notification.
  initialPlaceId?: string;
  initialOpenComments?: boolean;
  openNonce?: number;
}

type Sheet = 'none' | 'tag-filter' | 'settings';
type ViewMode = 'map' | 'list';

export function TripView({ trip, userId, onBack, onTripUpdated, initialPlaceId, initialOpenComments, openNonce }: Props) {
  const { places, loading, addPlace, deletePlace, toggleVisited, setPlaceTags, setPlaceParent, addPlaceImage, uploadPlaceImage, removePlaceImage, reorderPlaces } = usePlaces(trip.id);
  const { tags, createTag, deleteTag, updateTag } = useTags(trip.id);
  // Owned here rather than inside the notes page so folding survives the page
  // being closed and reopened, which is most of what folding is for.
  const { isFolded: isCollapsed, toggle: toggleCollapse, expand: expandSection } =
    useFoldState(trip.id, 'notes', { defaultFolded: true });
  // Bullets fold separately from the sections that hold them, and open by
  // default. Sharing one state was a real bug: with sections defaulting to
  // folded, every note bullet counted as folded too — which drew the ringed
  // "there is more here" dot on all of them and hid every nested note.
  const { isFolded: isNoteFolded, toggle: toggleNoteFold, expand: expandNote } =
    useFoldState(trip.id, 'bullets', { defaultFolded: false });
  // "Leave it where it is" for an anchor suggestion, remembered so the page
  // doesn't ask again every time it's opened.
  const { has: isAnchorDismissed, add: dismissAnchor, remove: clearAnchorDismissal } =
    usePersistentSet(`cairn:anchor-dismissed:${trip.id}`);
  // Both views start collapsed. An outline's value is being able to see the
  // shape of a trip at a glance and open only the part you want; opening
  // everything by default is the state you would immediately undo.
  const { isFolded: isListRowFolded, toggle: toggleListRow, expand: expandListRow } =
    useFoldState(trip.id, 'list', { defaultFolded: true });
  const {
    tripNotes, notesByPlace, loading: notesLoading,
    addNote, updateNote, removeNote, restoreNote, reorderNotes, setNoteDepths,
  } = useTripNotes(trip.id);
  // Owned here, not inside any one surface: the timeline, the list rows and
  // the place sheet all read the same rows, and three subscriptions would be
  // three chances for them to disagree about what today's plan is.
  const { visits, addVisit, updateVisit, removeVisit } = usePlaceVisits(trip.id);

  // Selection is an id — the place object is always derived fresh from `places`,
  // so realtime refetches and edits never leave the sheet stale.
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(initialPlaceId ?? null);
  const [jumpToComments, setJumpToComments] = useState(!!initialOpenComments);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [openSheet, setOpenSheet] = useState<Sheet>('none');
  // Its own state, not a Sheet variant: the notes page is a full-screen layer
  // that the place detail sheet opens *over*, so the two are shown at once.
  const [showNotes, setShowNotes] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('map');
  // What the map draws, as two independent switches rather than one.
  //
  // Spots start HIDDEN. A city with a dozen cafés in it is a pile of pins on
  // top of each other at any zoom that shows the whole route, so the useful
  // first look at a trip is its shape — the stops — with the detail available
  // on request. That is the opposite of the usual "nothing disappears until
  // asked" default, and it is safe here only because both switches are always
  // on screen together and anything you open is revealed automatically.
  const [showStops, setShowStops] = useState(true);
  const [showSpots, setShowSpots] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  // The map point being turned into a place (long-press), if any.
  const [pickedPoint, setPickedPoint] = useState<PickedPoint | null>(null);
  // Once created, the map stays mounted (hidden) across Map↔List toggles —
  // unmounting destroys the mapbox instance, and every toggle back would
  // re-download the style/tiles and refit bounds, losing the viewport.
  const [mapMounted, setMapMounted] = useState(viewMode === 'map');
  useEffect(() => {
    if (viewMode === 'map') setMapMounted(true);
  }, [viewMode]);

  const selectedPlace = places.find(p => p.id === selectedPlaceId) ?? null;
  // Filtered here rather than inside the map so the route line and the initial
  // fit follow the same rule as the pins — a route drawn through places you
  // cannot see would be the odd one out.
  // Only places actually inside a stop are hidden. A spot with no parent
  // — one whose stop was deleted before deletePlace learned to release its
  // children, or one a collaborator orphaned — behaves as a stop everywhere
  // else, and hiding it here made it unreachable rather than tidy.
  const isAnchoredSpot = (p: Place) => p.kind === 'spot' && !!p.parent_place_id;
  const mapPlaces = places.filter(p => (isAnchoredSpot(p) ? showSpots : showStops));
  // Counted after the tag filter, because that is what the map is actually
  // showing. Counting every anchored spot instead made the pill claim "12
  // hidden" while filtering by a tag only two of them carried — a number the
  // map could not be read to confirm. Same predicate as MapView's own filter.
  const passesTagFilter = (p: Place) =>
    activeTags.length === 0 || (p.tags ?? []).some(t => activeTags.includes(t.id));
  // Counted after the tag filter, because that is what the map is actually
  // showing. Counting every spot instead made a pill claim "12 hidden" while
  // filtering by a tag only two of them carried — a number the map could not
  // be read to confirm.
  const hiddenSpotCount = showSpots ? 0
    : places.filter(p => isAnchoredSpot(p) && passesTagFilter(p)).length;
  const hiddenStopCount = showStops ? 0
    : places.filter(p => !isAnchoredSpot(p) && passesTagFilter(p)).length;
  const isOwner = trip.owner_id === userId;
  // The map is mounted behind the list view and the outliner, so being the
  // current view is necessary but not sufficient for being the thing on screen.
  const mapIsShowing = viewMode === 'map' && !showNotes;

  // Re-open the deep-linked place whenever a new jump target arrives (nonce
  // changes even if the id repeats), without fighting a manual close.
  useEffect(() => {
    if (!initialPlaceId) return;
    setSelectedPlaceId(initialPlaceId);
    setJumpToComments(!!initialOpenComments);
  }, [openNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opening a place the map is currently hiding turns spots back on,
  // rather than flying to a coordinate with no marker on it and leaving the
  // map parked on empty ground when the sheet closes.
  //
  // Only while the map is the surface being looked at, which is not the same
  // as viewMode being 'map': the outliner is a full-screen layer that leaves
  // viewMode alone, so gating on that name only excluded the list view and
  // tapping a café's heading in the outline still silently turned the filter
  // back on. The map is also still MOUNTED behind both, so "not rendered" was
  // never the reason this was safe — MapView takes `visible` for that.
  // Keyed on the id, not the place object. Filing the OPEN place inside a stop
  // from the sheet's "Part of" picker makes it an anchored spot while it is
  // still selected — and an effect watching the object then read that as
  // "a hidden place was opened" and switched the filter back on, undoing the
  // user's hide from a sheet they were using for something else entirely.
  // Revealing is for the moment a hidden place is REACHED, which is a change
  // of selection.
  const revealedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedPlaceId) { revealedFor.current = null; return; }
    if (!mapIsShowing || !selectedPlace) return;
    if (revealedFor.current === selectedPlaceId) return;
    revealedFor.current = selectedPlaceId;
    // Either switch, not just the spots one: stops can be hidden now too, and
    // flying to a place with no marker under it is the same nonsense whichever
    // switch is responsible.
    if (isAnchoredSpot(selectedPlace)) { if (!showSpots) setShowSpots(true); }
    else if (!showStops) setShowStops(true);
  }, [mapIsShowing, selectedPlaceId, selectedPlace, showSpots, showStops]);

  useEscapeClose(() => setShowSearch(false));

  // Which overlay a back gesture should close. Ordered frontmost-first, and it
  // has to match what is actually painted on top rather than what feels
  // primary: the pick sheet and the search field sit above the place sheet, and
  // the place sheet opens OVER the outliner rather than replacing it.
  const topLayer =
    pickedPoint ? 'pick'
    : showSearch ? 'search'
    : selectedPlaceId ? 'place'
    : openSheet !== 'none' ? 'sheet'
    : showNotes ? 'notes'
    : null;

  // Exactly one layer per press, matching what the header's own back arrow
  // does. Each branch mirrors that overlay's onClose below; a layer whose
  // close does more than flip one flag (the place sheet also drops the
  // jump-to-comments intent) has to do the same here or a back gesture would
  // leave it armed for the next place opened.
  useHistoryLayer(topLayer, () => {
    if (pickedPoint) setPickedPoint(null);
    else if (showSearch) setShowSearch(false);
    else if (selectedPlaceId) { setSelectedPlaceId(null); setJumpToComments(false); }
    else if (openSheet !== 'none') setOpenSheet('none');
    else if (showNotes) setShowNotes(false);
  });

  // Shared by both entry points — the search field and a long-press on the
  // map — so a place added either way lands identically and opens its sheet.
  // google_place_id is optional: a custom place isn't on Google at all.
  const handleAddPlace = async (placeData: {
    name: string; address?: string; latitude: number;
    longitude: number; google_place_id?: string; image_url?: string; notes?: string;
    types?: string[];
    spanKm?: number;
  }) => {
    setShowSearch(false);
    const newPlace = await addPlace(placeData);
    // Only tear the pick sheet down once the row actually exists. Closing it
    // first discarded everything typed into the custom-place form whenever the
    // insert failed (offline, RLS, any Supabase error), leaving the user a
    // toast and no way to retry short of finding the same coordinate again.
    if (!newPlace) return false;
    // A new place filed inside a stop lands inside a row BOTH outlines keep
    // folded by default, so without this the place just added is nowhere on
    // either screen. Open its stop on each.
    //
    // expand, not toggle: toggle reads the current state and flips it, so a
    // second call for the same stop — two places added to it in a row —
    // closes what the first one opened. This wants "make sure it is open",
    // which is the operation expand exists for.
    if (newPlace.parent_place_id) {
      expandListRow(newPlace.parent_place_id);
      expandSection(newPlace.parent_place_id);
    }
    setPickedPoint(null);
    setSelectedPlaceId(newPlace.id);
    return true;
  };

  // Both the outliner's suggestion and the place sheet's picker go through
  // here, so re-filing a place means the same thing wherever it was done.
  //
  // Clearing the dismissal matters when a place is anchored and later released:
  // "leave it where it is" was said about a place that was top-level, and once
  // it has been somewhere else and come back, it no longer describes anything
  // the user believes. Without this, one mis-tap on a 26px X silenced the
  // suggestion for that place permanently, with no UI anywhere to undo it.
  const handleSetParent = async (childId: string, parentId: string | null) => {
    const updated = await setPlaceParent(childId, parentId);
    if (updated) clearAnchorDismissal(childId);
  };

  const handleToggleTag = (id: string) => {
    setActiveTags(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id]);
  };

  const handleUpdateTrip = async (updates: Partial<Trip>) => {
    const updated = await updateTrip(trip.id, updates);
    if (updated) onTripUpdated(updated);
  };

  const handleDeleteTrip = async () => {
    const ok = await deleteTrip(trip.id);
    if (ok) onBack();
  };

  const handleDeletePlace = async () => {
    if (!selectedPlace) return;
    await deletePlace(selectedPlace.id);
    setSelectedPlaceId(null);
  };

  return (
    <div className="trip-view">
      {/* Top bar */}
      <div className="trip-topbar">
        <button className="btn-icon" onClick={onBack} aria-label="Back">
          <ArrowLeft size={22} />
        </button>
        <h1 className="trip-topbar-title">{trip.name}</h1>
        <div className="topbar-actions">
          <button
            className="btn-icon"
            onClick={() => setShowNotes(true)}
            aria-label="Trip notes"
          >
            <NotebookPen size={20} />
          </button>
          <button
            className={`btn-icon ${activeTags.length > 0 ? 'btn-icon--active' : ''}`}
            onClick={() => setOpenSheet('tag-filter')}
            aria-label="Filter by tag"
          >
            <TagIcon size={20} />
            {activeTags.length > 0 && <span className="badge">{activeTags.length}</span>}
          </button>
          <button className="btn-icon" onClick={() => setOpenSheet('settings')} aria-label="Settings">
            <Settings size={20} />
          </button>
        </div>
      </div>

      {/* Map or List — the map is hidden, not unmounted, when the list shows */}
      <div className="trip-content">
        {mapMounted && (
          <div style={{ display: viewMode === 'map' ? 'contents' : 'none' }}>
            <MapBoundary>
              <MapView
                visible={mapIsShowing}
                places={mapPlaces}
                selectedPlace={selectedPlace}
                activeTags={activeTags}
                allTags={tags}
                onSelectPlace={(place) => setSelectedPlaceId(place.id)}
                onPickPoint={setPickedPoint}
                pendingPoint={pickedPoint}
              />
            </MapBoundary>
          </div>
        )}
        {/* Both switches, always together, and always present once the trip
            has anything on it at all.

            Gating the pair on the trip already HAVING a spot was wrong twice
            over. It hid the control on every flat trip, which is exactly where
            someone needs to learn the distinction exists — and because spots
            now start hidden, the first spot on such a trip would arrive
            invisible with no control on screen to explain where it went. A
            switch that appears only once you have used the feature cannot
            teach it.

            The count is what each one would reveal, measured after the tag
            filter, so the label can always be confirmed by looking at the
            map. */}
        {mapIsShowing && places.length > 0 && (
          <div className="map-kind-toggles">
            <button
              className={`map-kind-toggle ${showStops ? '' : 'map-kind-toggle--off'}`}
              onClick={() => setShowStops(v => !v)}
              aria-pressed={showStops}
            >
              {showStops ? <Eye size={15} /> : <EyeOff size={15} />}
              <span>Stops</span>
              {hiddenStopCount > 0 && <span className="map-kind-count">{hiddenStopCount}</span>}
            </button>
            <button
              className={`map-kind-toggle ${showSpots ? '' : 'map-kind-toggle--off'}`}
              onClick={() => setShowSpots(v => !v)}
              aria-pressed={showSpots}
            >
              {showSpots ? <Eye size={15} /> : <EyeOff size={15} />}
              <span>Spots</span>
              {hiddenSpotCount > 0 && <span className="map-kind-count">{hiddenSpotCount}</span>}
            </button>
          </div>
        )}

        {/* Turning both off is allowed — it is a legible thing to want, and the
            pills say why the map is bare. This only exists so an empty map is
            never mistaken for a broken one. */}
        {mapIsShowing && !loading && places.length > 0 && mapPlaces.length === 0 && (
          <div className="map-empty-hint">
            Nothing shown — turn Stops or Spots back on
          </div>
        )}

        {viewMode === 'map' && !loading && places.length === 0 && !showSearch && !pickedPoint && (
          <div className="map-empty-hint">
            <Plus size={16} />
            Tap + to add your first place — or press and hold anywhere on the map
          </div>
        )}
        {viewMode === 'list' && (
          <PlaceListView
            places={places}
            activeTags={activeTags}
            allTags={tags}
            visits={visits}
            onSelectPlace={(place) => setSelectedPlaceId(place.id)}
            onReorder={reorderPlaces}
            onSetParent={handleSetParent}
            isFolded={isListRowFolded}
            onToggleFold={toggleListRow}
            onExpandFold={expandListRow}
          />
        )}
      </div>

      {/* Backdrop — dims the map/list behind the search pill; tap to cancel */}
      {showSearch && (
        <div className="search-backdrop" onClick={() => setShowSearch(false)} />
      )}

      {/* Bottom bar — Map/List pill stays put; the + bubble morphs into the search bar in place */}
      <div className="trip-bottombar">
        <div className={`bottombar-pill ${showSearch ? 'bottombar-pill--hidden' : ''}`}>
          <button
            className={`bottombar-tab ${viewMode === 'map' ? 'bottombar-tab--active' : ''}`}
            onClick={() => setViewMode('map')}
          >
            <Map size={20} />
            <span>Map</span>
          </button>

          <div className="fab-spacer" />

          <button
            className={`bottombar-tab ${viewMode === 'list' ? 'bottombar-tab--active' : ''}`}
            onClick={() => setViewMode('list')}
          >
            <List size={20} />
            <span>List</span>
          </button>
        </div>

        <div className={`search-bubble ${showSearch ? 'search-bubble--open' : ''}`}>
          {showSearch ? (
            <PlaceSearch onSelect={handleAddPlace} />
          ) : (
            <button className="search-bubble-trigger" onClick={() => setShowSearch(true)} aria-label="Add place">
              <Plus size={22} />
            </button>
          )}
        </div>
      </div>

      {/* Sheets */}
      {pickedPoint && (
        <MapPickSheet
          point={pickedPoint}
          onAdd={handleAddPlace}
          onClose={() => setPickedPoint(null)}
        />
      )}

      {showNotes && (
        <TripNotesPage
          places={places}
          allTags={tags}
          visits={visits}
          tripNotes={tripNotes}
          notesByPlace={notesByPlace}
          loading={notesLoading}
          onAdd={addNote}
          onUpdate={updateNote}
          onRemove={removeNote}
          onRestore={restoreNote}
          onSetDepths={setNoteDepths}
          onReorder={reorderNotes}
          isCollapsed={isCollapsed}
          toggleCollapse={toggleCollapse}
          isNoteFolded={isNoteFolded}
          toggleNoteFold={toggleNoteFold}
          onExpandNote={expandNote}
          onAnchorPlace={(childId, parentId) => { void handleSetParent(childId, parentId); }}
          isAnchorDismissed={isAnchorDismissed}
          onDismissAnchor={dismissAnchor}
          onSelectPlace={(placeId) => setSelectedPlaceId(placeId)}
          onClose={() => setShowNotes(false)}
        />
      )}

      {selectedPlace && (
        <PlaceDetailSheet
          place={selectedPlace}
          allTags={tags}
          scrollToComments={jumpToComments}
          onCommentsShown={() => setJumpToComments(false)}
          onClose={() => { setSelectedPlaceId(null); setJumpToComments(false); }}
          onToggleVisited={() => toggleVisited(selectedPlace.id, selectedPlace.status)}
          onDelete={handleDeletePlace}
          onSetTags={(tagIds) => setPlaceTags(selectedPlace.id, tagIds)}
          onSetParent={(parentId) => { void handleSetParent(selectedPlace.id, parentId); }}
          onAddImage={(url, caption) => addPlaceImage(selectedPlace.id, url, caption)}
          onUploadImage={(file) => uploadPlaceImage(selectedPlace.id, file)}
          onRemoveImage={(imageId) => removePlaceImage(selectedPlace.id, imageId)}
          onCreateTag={createTag}
          visits={visits}
          onAddVisit={(startsOn, endsOn) => addVisit(selectedPlace.id, startsOn, endsOn)}
          onUpdateVisit={updateVisit}
          onRemoveVisit={removeVisit}
          notes={notesByPlace.get(selectedPlace.id) ?? []}
          allPlaces={places}
          onAddNote={(body, opts) => addNote(body, selectedPlace.id, opts)}
          onUpdateNote={updateNote}
          onRemoveNote={removeNote}
          onRestoreNote={restoreNote}
          onSetNoteDepths={setNoteDepths}
          onReorderNotes={reorderNotes}
        />
      )}

      {openSheet === 'tag-filter' && (
        <TagFilterSheet
          tags={tags}
          activeTags={activeTags}
          onToggleTag={handleToggleTag}
          onClearTags={() => setActiveTags([])}
          onCreateTag={createTag}
          onDeleteTag={deleteTag}
          onUpdateTag={updateTag}
          onClose={() => setOpenSheet('none')}
        />
      )}

      {openSheet === 'settings' && (
        <TripSettingsSheet
          trip={trip}
          onClose={() => setOpenSheet('none')}
          onUpdate={handleUpdateTrip}
          onDelete={handleDeleteTrip}
          onUploadCover={(file) => uploadTripCover(trip.id, file)}
          isOwner={isOwner}
        />
      )}
    </div>
  );
}
