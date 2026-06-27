import { useEffect, useRef, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import type { Place, Tag } from '../types';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN as string;

interface Props {
  places: Place[];
  selectedPlace: Place | null;
  activeTags: string[];
  allTags: Tag[];
  onSelectPlace: (place: Place) => void;
}

const PLANNED_COLOR = '#6366f1';
const VISITED_COLOR = '#22c55e';

export function MapView({ places, selectedPlace, activeTags, allTags, onSelectPlace }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<Map<string, mapboxgl.Marker>>(new Map());

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    mapRef.current = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [0, 20],
      zoom: 2,
    });
    mapRef.current.addControl(new mapboxgl.NavigationControl(), 'bottom-right');
    mapRef.current.addControl(new mapboxgl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), 'bottom-right');
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  const getTagColor = useCallback((place: Place) => {
    if (place.tags && place.tags.length > 0) {
      const t = allTags.find(t => t.id === place.tags![0].id);
      if (t) return t.color;
    }
    return place.status === 'visited' ? VISITED_COLOR : PLANNED_COLOR;
  }, [allTags]);

  // Filter and update markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const visible = places.filter(p =>
      activeTags.length === 0 || (p.tags ?? []).some(t => activeTags.includes(t.id))
    );

    const visibleIds = new Set(visible.map(p => p.id));

    // Remove stale markers
    markersRef.current.forEach((marker, id) => {
      if (!visibleIds.has(id)) {
        marker.remove();
        markersRef.current.delete(id);
      }
    });

    visible.forEach(place => {
      const color = getTagColor(place);
      const isSelected = selectedPlace?.id === place.id;

      if (markersRef.current.has(place.id)) {
        const existing = markersRef.current.get(place.id)!;
        const el = existing.getElement();
        el.style.background = color;
        el.style.transform = isSelected ? 'scale(1.4)' : 'scale(1)';
        el.style.zIndex = isSelected ? '10' : '1';
        return;
      }

      const el = document.createElement('div');
      el.className = 'map-marker';
      el.style.background = color;
      el.style.width = '28px';
      el.style.height = '28px';
      el.style.borderRadius = '50% 50% 50% 0';
      el.style.transform = 'rotate(-45deg)';
      el.style.border = '2px solid white';
      el.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
      el.style.cursor = 'pointer';
      el.style.transition = 'transform 0.2s';

      const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([place.longitude, place.latitude])
        .addTo(map);

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        onSelectPlace(place);
      });

      markersRef.current.set(place.id, marker);
    });
  }, [places, activeTags, selectedPlace, allTags, getTagColor, onSelectPlace]);

  // Fly to selected place
  useEffect(() => {
    if (!selectedPlace || !mapRef.current) return;
    mapRef.current.flyTo({
      center: [selectedPlace.longitude, selectedPlace.latitude],
      zoom: Math.max(mapRef.current.getZoom(), 13),
      duration: 600,
    });
  }, [selectedPlace]);

  // Fit bounds when places load
  useEffect(() => {
    const map = mapRef.current;
    if (!map || places.length === 0) return;
    const bounds = new mapboxgl.LngLatBounds();
    places.forEach(p => bounds.extend([p.longitude, p.latitude]));
    map.fitBounds(bounds, { padding: 80, maxZoom: 14, duration: 800 });
  }, [places.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={containerRef} className="map-container" />;
}
