import { useEffect, useRef, useCallback, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import type { Place, Tag } from '../types';
import { buildVisitedRouteGeoJSON, type RouteFeatureCollection } from '../lib/routing';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN as string;

// Streets give the map real structure — roads, buildings, parks, labels —
// instead of the flat light/dark canvases, while our ink markers still
// pop against either.
const LIGHT_STYLE = 'mapbox://styles/mapbox/streets-v12';
const DARK_STYLE = 'mapbox://styles/mapbox/navigation-night-v1';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

const ROUTE_SOURCE_ID = 'visited-route';
const EMPTY_ROUTE: RouteFeatureCollection = { type: 'FeatureCollection', features: [] };

// Re-added every time the style (re)loads, since setStyle wipes custom
// sources/layers — idempotent, so calling it redundantly is harmless.
function ensureRouteLayers(map: mapboxgl.Map) {
  if (map.getSource(ROUTE_SOURCE_ID)) return;
  const ink = darkQuery.matches ? '#f2f3f4' : '#131416';
  map.addSource(ROUTE_SOURCE_ID, { type: 'geojson', data: EMPTY_ROUTE });
  map.addLayer({
    id: 'visited-route-real',
    type: 'line',
    source: ROUTE_SOURCE_ID,
    filter: ['==', ['get', 'real'], true],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ink, 'line-width': 2.5, 'line-opacity': 0.55 },
  });
  map.addLayer({
    id: 'visited-route-inferred',
    type: 'line',
    source: ROUTE_SOURCE_ID,
    filter: ['==', ['get', 'real'], false],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ink, 'line-width': 2, 'line-opacity': 0.4, 'line-dasharray': [2, 2] },
  });
}

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

    // setStyle (initial load, or the scheme-change above) wipes any custom
    // source/layers — re-add them every time the style finishes (re)loading
    const map = mapRef.current;
    const onStyleData = () => ensureRouteLayers(map);
    map.on('styledata', onStyleData);

    return () => {
      darkQuery.removeEventListener('change', onSchemeChange);
      map.off('styledata', onStyleData);
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

  // Places visited, in the actual order they were visited (not the list's
  // manual sort order) — the sequence the route line traces
  const visitedPlaces = useMemo(() => {
    return places
      .filter(p => p.status === 'visited' && p.visited_at)
      .sort((a, b) => new Date(a.visited_at!).getTime() - new Date(b.visited_at!).getTime());
  }, [places]);

  // Stable primitive key — only refetch routes when the visited set,
  // order, or coordinates actually change, not on unrelated place edits
  const visitedKey = visitedPlaces.map(p => `${p.id}:${p.longitude},${p.latitude}`).join('|');

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const applyEmpty = () => {
      ensureRouteLayers(map);
      (map.getSource(ROUTE_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined)?.setData(EMPTY_ROUTE);
    };

    if (visitedPlaces.length < 2) {
      if (map.isStyleLoaded()) applyEmpty();
      else map.once('load', applyEmpty);
      return;
    }

    let cancelled = false;
    const points: [number, number][] = visitedPlaces.map(p => [p.longitude, p.latitude]);

    buildVisitedRouteGeoJSON(points).then(geojson => {
      if (cancelled) return;
      const apply = () => {
        ensureRouteLayers(map);
        (map.getSource(ROUTE_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined)?.setData(geojson);
      };
      if (map.isStyleLoaded()) apply();
      else map.once('load', apply);
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitedKey]);

  return <div ref={containerRef} className="map-container" />;
}
