import { useState } from 'react';
import { ArrowLeft, Tag as TagIcon, Settings, List, Map, Plus } from 'lucide-react';
import type { Trip } from '../types';
import { usePlaces } from '../hooks/usePlaces';
import { useTags } from '../hooks/useTags';
import { useTrips } from '../hooks/useTrips';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { MapView } from './MapView';
import { PlaceSearch } from './PlaceSearch';
import { PlaceDetailSheet } from './PlaceDetailSheet';
import { TagFilterSheet } from './TagFilterSheet';
import { TripSettingsSheet } from './TripSettingsSheet';
import { PlaceListView } from './PlaceListView';

interface Props {
  trip: Trip;
  userId: string;
  onBack: () => void;
}

type Sheet = 'none' | 'tag-filter' | 'settings';
type ViewMode = 'map' | 'list';

export function TripView({ trip, userId, onBack }: Props) {
  const { places, loading, addPlace, updatePlace, deletePlace, toggleVisited, setPlaceTags, addPlaceImage, removePlaceImage, reorderPlaces } = usePlaces(trip.id);
  const { tags, createTag, deleteTag, updateTag } = useTags(trip.id);
  const { updateTrip, deleteTrip } = useTrips(userId);

  // Selection is an id — the place object is always derived fresh from `places`,
  // so realtime refetches and edits never leave the sheet stale.
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [openSheet, setOpenSheet] = useState<Sheet>('none');
  const [viewMode, setViewMode] = useState<ViewMode>('map');
  const [showSearch, setShowSearch] = useState(false);

  const selectedPlace = places.find(p => p.id === selectedPlaceId) ?? null;
  const isOwner = trip.owner_id === userId;

  useEscapeClose(() => setShowSearch(false));

  const handleAddPlace = async (placeData: {
    name: string; address: string; latitude: number;
    longitude: number; google_place_id: string; image_url?: string;
  }) => {
    setShowSearch(false);
    const newPlace = await addPlace(placeData);
    if (newPlace) setSelectedPlaceId(newPlace.id);
  };

  const handleToggleTag = (id: string) => {
    setActiveTags(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id]);
  };

  const handleUpdateTrip = async (updates: Partial<Trip>) => {
    await updateTrip(trip.id, updates);
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

  const filteredCount = activeTags.length > 0
    ? places.filter(p => (p.tags ?? []).some(t => activeTags.includes(t.id))).length
    : places.length;

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

      {/* Map or List */}
      <div className="trip-content">
        {viewMode === 'map' ? (
          <>
            <MapView
              places={places}
              selectedPlace={selectedPlace}
              activeTags={activeTags}
              allTags={tags}
              onSelectPlace={(place) => setSelectedPlaceId(place.id)}
            />
            {!loading && places.length === 0 && !showSearch && (
              <div className="map-empty-hint">
                <Plus size={16} />
                Tap the + button to add your first place
              </div>
            )}
          </>
        ) : (
          <PlaceListView
            places={places}
            activeTags={activeTags}
            allTags={tags}
            onSelectPlace={(place) => setSelectedPlaceId(place.id)}
            onReorder={reorderPlaces}
          />
        )}
      </div>

      {/* Search overlay */}
      {showSearch && (
        <div className="search-overlay">
          <PlaceSearch onSelect={handleAddPlace} />
          <button className="btn-secondary search-cancel" onClick={() => setShowSearch(false)}>
            Cancel
          </button>
        </div>
      )}

      {/* Bottom bar — floating island pill with sliding indicator */}
      <div className="trip-bottombar">
        <div className="bottombar-pill">
          <div className="bottombar-tabs">
            <div className={`bottombar-indicator ${viewMode === 'list' ? 'bottombar-indicator--list' : ''}`} />
            <button
              className={`bottombar-tab ${viewMode === 'map' ? 'bottombar-tab--active' : ''}`}
              onClick={() => setViewMode('map')}
            >
              <Map size={20} />
              <span>Map</span>
            </button>
            <button
              className={`bottombar-tab ${viewMode === 'list' ? 'bottombar-tab--active' : ''}`}
              onClick={() => setViewMode('list')}
            >
              <List size={20} />
              <span>
                List{filteredCount > 0 && <span key={filteredCount} className="tab-count">&nbsp;{filteredCount}</span>}
              </span>
            </button>
          </div>

          <button className="fab" onClick={() => setShowSearch(true)} aria-label="Add place">
            <Plus size={22} />
          </button>
        </div>
      </div>

      {/* Sheets */}
      {selectedPlace && (
        <PlaceDetailSheet
          place={selectedPlace}
          allTags={tags}
          onClose={() => setSelectedPlaceId(null)}
          onToggleVisited={() => toggleVisited(selectedPlace.id, selectedPlace.status)}
          onUpdate={(updates) => updatePlace(selectedPlace.id, updates)}
          onDelete={handleDeletePlace}
          onSetTags={(tagIds) => setPlaceTags(selectedPlace.id, tagIds)}
          onAddImage={(url, caption) => addPlaceImage(selectedPlace.id, url, caption)}
          onRemoveImage={(imageId) => removePlaceImage(selectedPlace.id, imageId)}
          onCreateTag={createTag}
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
          userId={userId}
          onClose={() => setOpenSheet('none')}
          onUpdate={handleUpdateTrip}
          onDelete={handleDeleteTrip}
          isOwner={isOwner}
        />
      )}
    </div>
  );
}
