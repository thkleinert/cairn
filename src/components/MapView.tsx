import { useEffect, useRef, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import type { Place, Tag } from '../types';
import { MARKER_PLANNED_COLOR, MARKER_VISITED_COLOR } from '../constants';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN as string;

interface Props {
  places: Place[];
  selectedPlace: Place | null;
  activeTags: string[];
  allTags: Tag[];
  onSelectPlace: (place: Place) => void;
}

// Outer element is positioned by Mapbox (it owns its transform);
// the inner element carries our visual styles so scaling never
// conflicts with Mapbox's translate.
function createMarkerEl(color: string, emoji: string | null): { outer: HTMLDivElement; inner: HTMLDivElement } {
  const outer = document.createElement('div');
  const inner = document.createElement('div');
  inner.className = emoji ? 'map-marker map-marker--emoji' : 'map-marker map-marker--pin';
  inner.style.setProperty('--marker-color', color);
  if (emoji) inner.textContent = emoji;
  outer.appendChild(inner);
  return { outer, inner };
}

function styleMarker(inner: HTMLDivElement, color: string, emoji: string | null, isSelected: boolean) {
  inner.className = [
    'map-marker',
    emoji ? 'map-marker--emoji' : 'map-marker--pin',
    isSelected ? 'map-marker--selected' : '',
  ].filter(Boolean).join(' ');
  inner.style.setProperty('--marker-color', color);
  inner.textContent = emoji ?? '';
  // z-index lives on the outer (Mapbox-positioned) element so the
  // selected marker renders above its neighbors
  if (inner.parentElement) inner.parentElement.style.zIndex = isSelected ? '10' : '1';
}

export function MapView({ places, selectedPlace, activeTags, allTags, onSelectPlace }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<Map<string, { marker: mapboxgl.Marker; anchor: string }>>(new Map());
  const didFitRef = useRef(false);

  // Keep refs to the latest props so marker click handlers never go stale
  const placesRef = useRef(places);
  placesRef.current = places;
  const onSelectPlaceRef = useRef(onSelectPlace);
  onSelectPlaceRef.current = onSelectPlace;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    mapRef.current = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [0, 20],
      zoom: 2,
    });
    mapRef.current.addControl(new mapboxgl.NavigationControl(), 'bottom-right');
    mapRef.current.addControl(
      new mapboxgl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }),
      'bottom-right'
    );
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  const getTagInfo = useCallback((place: Place): { color: string; emoji: string | null } => {
    if (place.tags && place.tags.length > 0) {
      const t = allTags.find(t => t.id === place.tags![0].id);
      if (t) return { color: t.color, emoji: t.icon ?? null };
    }
    return {
      color: place.status === 'visited' ? MARKER_VISITED_COLOR : MARKER_PLANNED_COLOR,
      emoji: null,
    };
  }, [allTags]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const visible = places.filter(p =>
      activeTags.length === 0 || (p.tags ?? []).some(t => activeTags.includes(t.id))
    );
    const visibleIds = new Set(visible.map(p => p.id));

    markersRef.current.forEach((entry, id) => {
      if (!visibleIds.has(id)) {
        entry.marker.remove();
        markersRef.current.delete(id);
      }
    });

    visible.forEach(place => {
      const { color, emoji } = getTagInfo(place);
      const isSelected = selectedPlace?.id === place.id;
      const anchor = emoji ? 'center' : 'bottom';

      const existing = markersRef.current.get(place.id);
      if (existing) {
        if (existing.anchor === anchor) {
          const inner = existing.marker.getElement().firstElementChild as HTMLDivElement;
          styleMarker(inner, color, emoji, isSelected);
          existing.marker.setLngLat([place.longitude, place.latitude]);
          return;
        }
        // Anchor depends on marker shape — recreate when it changes (tag added/removed)
        existing.marker.remove();
        markersRef.current.delete(place.id);
      }

      const { outer, inner } = createMarkerEl(color, emoji);
      if (isSelected) styleMarker(inner, color, emoji, true);
      const marker = new mapboxgl.Marker({ element: outer, anchor })
        .setLngLat([place.longitude, place.latitude])
        .addTo(map);

      outer.addEventListener('click', (e) => {
        e.stopPropagation();
        const current = placesRef.current.find(p => p.id === place.id);
        if (current) onSelectPlaceRef.current(current);
      });

      markersRef.current.set(place.id, { marker, anchor });
    });
  }, [places, activeTags, selectedPlace, allTags, getTagInfo]);

  useEffect(() => {
    if (!selectedPlace || !mapRef.current) return;
    mapRef.current.flyTo({
      center: [selectedPlace.longitude, selectedPlace.latitude],
      zoom: Math.max(mapRef.current.getZoom(), 13),
      duration: 600,
    });
  }, [selectedPlace]);

  // Fit bounds once on initial load — never yank the viewport on add/remove
  useEffect(() => {
    const map = mapRef.current;
    if (!map || places.length === 0 || didFitRef.current) return;
    didFitRef.current = true;
    const bounds = new mapboxgl.LngLatBounds();
    places.forEach(p => bounds.extend([p.longitude, p.latitude]));
    map.fitBounds(bounds, { padding: 80, maxZoom: 14, duration: 800 });
  }, [places.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={containerRef} className="map-container" />;
}
