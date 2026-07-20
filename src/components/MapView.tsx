import { useEffect, useRef, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import type { Place, Tag } from '../types';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN as string;

// Streets give the map real structure — roads, buildings, parks, labels —
// instead of the flat light/dark canvases, while our ink markers still
// pop against either.
const LIGHT_STYLE = 'mapbox://styles/mapbox/streets-v12';
const DARK_STYLE = 'mapbox://styles/mapbox/navigation-night-v1';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

interface Props {
  places: Place[];
  selectedPlace: Place | null;
  activeTags: string[];
  allTags: Tag[];
  onSelectPlace: (place: Place) => void;
}

// Outer element is positioned by Mapbox (it owns its transform);
// the drop wrapper carries the entrance animation; the inner element
// carries the visual styles so scaling never conflicts with either.
function createMarkerEl(emoji: string | null, dropDelay: number): { outer: HTMLDivElement; inner: HTMLDivElement } {
  const outer = document.createElement('div');
  const drop = document.createElement('div');
  drop.className = 'map-marker-drop';
  drop.style.animationDelay = `${dropDelay}ms`;
  const inner = document.createElement('div');
  inner.className = emoji ? 'map-marker map-marker--emoji' : 'map-marker map-marker--pin';
  if (emoji) inner.textContent = emoji;
  drop.appendChild(inner);
  outer.appendChild(drop);
  return { outer, inner };
}

function styleMarker(inner: HTMLDivElement, emoji: string | null, isVisited: boolean, isSelected: boolean) {
  inner.className = [
    'map-marker',
    emoji ? 'map-marker--emoji' : 'map-marker--pin',
    isVisited ? 'map-marker--visited' : '',
    isSelected ? 'map-marker--selected' : '',
  ].filter(Boolean).join(' ');
  inner.textContent = emoji ?? '';
  const outer = inner.parentElement?.parentElement;
  if (outer) outer.style.zIndex = isSelected ? '10' : '1';
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
      style: darkQuery.matches ? DARK_STYLE : LIGHT_STYLE,
      center: [0, 20],
      zoom: 2,
    });
    mapRef.current.addControl(new mapboxgl.NavigationControl(), 'bottom-right');
    mapRef.current.addControl(
      new mapboxgl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }),
      'bottom-right'
    );

    const onSchemeChange = (e: MediaQueryListEvent) => {
      mapRef.current?.setStyle(e.matches ? DARK_STYLE : LIGHT_STYLE);
    };
    darkQuery.addEventListener('change', onSchemeChange);

    return () => {
      darkQuery.removeEventListener('change', onSchemeChange);
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  const getEmoji = useCallback((place: Place): string | null => {
    if (place.tags && place.tags.length > 0) {
      const t = allTags.find(t => t.id === place.tags![0].id);
      if (t?.icon) return t.icon;
    }
    return null;
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

    let newIndex = 0;
    visible.forEach(place => {
      const emoji = getEmoji(place);
      const isVisited = place.status === 'visited';
      const isSelected = selectedPlace?.id === place.id;
      const anchor = emoji ? 'center' : 'bottom';

      const existing = markersRef.current.get(place.id);
      if (existing) {
        if (existing.anchor === anchor) {
          const inner = existing.marker.getElement()
            .firstElementChild!.firstElementChild as HTMLDivElement;
          styleMarker(inner, emoji, isVisited, isSelected);
          existing.marker.setLngLat([place.longitude, place.latitude]);
          return;
        }
        // Anchor depends on marker shape — recreate when it changes (tag added/removed)
        existing.marker.remove();
        markersRef.current.delete(place.id);
      }

      // Stagger the drop-in for batches; a single new marker drops immediately
      const dropDelay = Math.min(newIndex * 45, 450);
      newIndex += 1;

      const { outer, inner } = createMarkerEl(emoji, dropDelay);
      styleMarker(inner, emoji, isVisited, isSelected);
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
  }, [places, activeTags, selectedPlace, allTags, getEmoji]);

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
