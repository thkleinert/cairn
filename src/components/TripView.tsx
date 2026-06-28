import { useState } from 'react';
import { ArrowLeft, Tag as TagIcon, Settings, List, Map, Plus } from 'lucide-react';
import type { Trip, Place } from '../types';
import { usePlaces } from '../hooks/usePlaces';
import { useTags } from '../hooks/useTags';
import { useTrips } from '../hooks/useTrips';
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
  const { places, addPlace, updatePlace, deletePlace, toggleVisited, setPlaceTags, addPlaceImage, removePlaceImage } = usePlaces(trip.id);
  const { tags, createTag, deleteTag } = useTags(trip.id);
  const { updateTrip, deleteTrip } = useTrips(userId);

  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [openSheet, setOpenSheet] = useState<Sheet>('none');
  const [viewMode, setViewMode] = useState<ViewMode>('map');
  const [showSearch, setShowSearch] = useState(false);

  const isOwner = trip.owner_id === userId;

  const handleAddPlace = async (placeData: {
    name: string; address: string; latitude: number;
    longitude: number; google_place_id: string; image_url?: string;
  }) => {
    setShowSearch(false);
    const newPlace = await addPlace(placeData);
    if (newPlace) setSelectedPlace({ ...newPlace, tags: [] });
  };

  const handleToggleTag = (id: string) => {
    setActiveTags(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id]);
  };

  const handleUpdateTrip = async (updates: Partial<Trip>) => {
    await updateTrip(trip.id, updates);
  };

  const handleDeleteTrip = async () => {
    await deleteTrip(trip.id);
    onBack();
  };

  const handleDeletePlace = async () => {
    if (!selectedPlace) return;
    await deletePlace(selectedPlace.id);
    setSelectedPlace(null);
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
          <MapView
            places={places}
            selectedPlace={selectedPlace}
            activeTags={activeTags}
            allTags={tags}
            onSelectPlace={setSelectedPlace}
          />
        ) : (
          <PlaceListView
            places={places}
            activeTags={activeTags}
            allTags={tags}
            onSelectPlace={setSelectedPlace}
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

      {/* Bottom bar */}
      <div className="trip-bottombar">
        <button
          className={`bottombar-tab ${viewMode === 'map' ? 'bottombar-tab--active' : ''}`}
          onClick={() => setViewMode('map')}
        >
          <Map size={20} />
          <span>Map</span>
        </button>

        <button className="fab" onClick={() => setShowSearch(true)} aria-label="Add place">
          <Plus size={24} />
        </button>

        <button
          className={`bottombar-tab ${viewMode === 'list' ? 'bottombar-tab--active' : ''}`}
          onClick={() => setViewMode('list')}
        >
          <List size={20} />
          <span>List {filteredCount > 0 ? `(${filteredCount})` : ''}</span>
        </button>
      </div>

      {/* Sheets */}
      {selectedPlace && (
        <PlaceDetailSheet
          place={selectedPlace}
          allTags={tags}
          onClose={() => setSelectedPlace(null)}
          onToggleVisited={() => {
            toggleVisited(selectedPlace.id, selectedPlace.status);
            setSelectedPlace(prev => prev ? {
              ...prev,
              status: prev.status === 'planned' ? 'visited' : 'planned',
              visited_at: prev.status === 'planned' ? new Date().toISOString() : undefined,
            } : null);
          }}
          onUpdate={(updates) => {
            updatePlace(selectedPlace.id, updates);
            setSelectedPlace(prev => prev ? { ...prev, ...updates } : null);
          }}
          onDelete={handleDeletePlace}
          onSetTags={(tagIds) => {
            setPlaceTags(selectedPlace.id, tagIds);
            setSelectedPlace(prev => prev ? {
              ...prev,
              tags: tags.filter(t => tagIds.includes(t.id)),
            } : null);
          }}
          onAddImage={async (url, caption) => {
            const img = await addPlaceImage(selectedPlace.id, url, caption);
            if (img) setSelectedPlace(prev => prev ? { ...prev, images: [...(prev.images ?? []), img] } : null);
            return img;
          }}
          onRemoveImage={(imageId) => {
            removePlaceImage(selectedPlace.id, imageId);
            setSelectedPlace(prev => prev ? { ...prev, images: (prev.images ?? []).filter(i => i.id !== imageId) } : null);
          }}
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
