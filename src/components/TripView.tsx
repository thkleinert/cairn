import { useState, useEffect, lazy } from 'react';
import { MapBoundary } from './MapBoundary';
import { ArrowLeft, Tag as TagIcon, Settings, List, Map, Plus, NotebookPen } from 'lucide-react';
import type { PickedPoint, Trip } from '../types';
import { usePlaces } from '../hooks/usePlaces';
import { useTripNotes } from '../hooks/useTripNotes';
import { useTags } from '../hooks/useTags';
import { updateTrip, deleteTrip, uploadTripCover } from '../lib/trips';
import { useEscapeClose } from '../hooks/useEscapeClose';
// Lazy: mapbox-gl is ~90% of the bundle; splitting it means the auth screen,
// trip list, and invite/share landings load without it. The map chunk starts
// fetching the moment a trip opens.
const MapView = lazy(() => import('./MapView').then(m => ({ default: m.MapView })));
import { PlaceSearch } from './PlaceSearch';
import { MapPickSheet } from './MapPickSheet';
import { TripNotesSheet } from './TripNotesSheet';
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

type Sheet = 'none' | 'tag-filter' | 'settings' | 'notes';
type ViewMode = 'map' | 'list';

export function TripView({ trip, userId, onBack, onTripUpdated, initialPlaceId, initialOpenComments, openNonce }: Props) {
  const { places, loading, addPlace, updatePlace, deletePlace, toggleVisited, setPlaceTags, addPlaceImage, uploadPlaceImage, removePlaceImage, reorderPlaces } = usePlaces(trip.id);
  const { tags, createTag, deleteTag, updateTag } = useTags(trip.id);
  const {
    tripNotes, notesByPlace,
    addNote, updateNote, removeNote, reorderNotes,
  } = useTripNotes(trip.id);

  // Selection is an id — the place object is always derived fresh from `places`,
  // so realtime refetches and edits never leave the sheet stale.
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(initialPlaceId ?? null);
  const [jumpToComments, setJumpToComments] = useState(!!initialOpenComments);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [openSheet, setOpenSheet] = useState<Sheet>('none');
  const [viewMode, setViewMode] = useState<ViewMode>('map');
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
  const isOwner = trip.owner_id === userId;

  // Re-open the deep-linked place whenever a new jump target arrives (nonce
  // changes even if the id repeats), without fighting a manual close.
  useEffect(() => {
    if (!initialPlaceId) return;
    setSelectedPlaceId(initialPlaceId);
    setJumpToComments(!!initialOpenComments);
  }, [openNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEscapeClose(() => setShowSearch(false));

  // Shared by both entry points — the search field and a long-press on the
  // map — so a place added either way lands identically and opens its sheet.
  // google_place_id is optional: a custom place isn't on Google at all.
  const handleAddPlace = async (placeData: {
    name: string; address?: string; latitude: number;
    longitude: number; google_place_id?: string; image_url?: string; notes?: string;
  }) => {
    setShowSearch(false);
    const newPlace = await addPlace(placeData);
    // Only tear the pick sheet down once the row actually exists. Closing it
    // first discarded everything typed into the custom-place form whenever the
    // insert failed (offline, RLS, any Supabase error), leaving the user a
    // toast and no way to retry short of finding the same coordinate again.
    if (!newPlace) return false;
    setPickedPoint(null);
    setSelectedPlaceId(newPlace.id);
    return true;
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
            onClick={() => setOpenSheet('notes')}
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
                places={places}
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
            onSelectPlace={(place) => setSelectedPlaceId(place.id)}
            onReorder={reorderPlaces}
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

      {openSheet === 'notes' && (
        <TripNotesSheet
          places={places}
          allTags={tags}
          tripNotes={tripNotes}
          notesByPlace={notesByPlace}
          onAdd={addNote}
          onUpdate={updateNote}
          onRemove={removeNote}
          onReorder={reorderNotes}
          onSelectPlace={(placeId) => setSelectedPlaceId(placeId)}
          onClose={() => setOpenSheet('none')}
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
          onUpdate={(updates) => updatePlace(selectedPlace.id, updates)}
          onDelete={handleDeletePlace}
          onSetTags={(tagIds) => setPlaceTags(selectedPlace.id, tagIds)}
          onAddImage={(url, caption) => addPlaceImage(selectedPlace.id, url, caption)}
          onUploadImage={(file) => uploadPlaceImage(selectedPlace.id, file)}
          onRemoveImage={(imageId) => removePlaceImage(selectedPlace.id, imageId)}
          onCreateTag={createTag}
          notes={notesByPlace.get(selectedPlace.id) ?? []}
          allPlaces={places}
          onAddNote={(body) => addNote(body, selectedPlace.id)}
          onUpdateNote={updateNote}
          onRemoveNote={removeNote}
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
