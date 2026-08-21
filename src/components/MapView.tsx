import { useEffect, useRef, useCallback, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { Place, PickedPoint, Tag } from '../types';
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

// Long-press to drop a pin — the gesture Google Maps itself uses, so no mode
// to enter or leave. A short tap stays free for panning and marker taps.
const LONG_PRESS_MS = 500;
// A press that drifts further than this was a pan, not a press.
const LONG_PRESS_MOVE_PX = 10;
// Fingertip-sized box for reading the POI label under the press.
const POI_QUERY_PAD_PX = 12;
// Android fires `contextmenu` from the same long press our touch timer is
// already timing; either may land first, so ignore a second pick this soon.
const PICK_DEDUPE_MS = 800;

// Only the two fields we read. Declared locally because mapbox-gl's own
// GeoJSONFeature inherits `properties` from @types/geojson, which is a
// devDependency of mapbox-gl and so isn't installed here — same reason
// lib/routing.ts spells out its own GeoJSON shapes.
type QueriedFeature = { sourceLayer?: string; properties?: Record<string, unknown> | null };

// The POI label the style has *already drawn* at this point — free, instant,
// and exactly the name the user is looking at, which a nearby search need not
// agree with. Used only to prefill; the Google lookup still runs.
function renderedPoiName(map: mapboxgl.Map, pt: mapboxgl.Point): string | undefined {
  try {
    const box: [mapboxgl.PointLike, mapboxgl.PointLike] = [
      [pt.x - POI_QUERY_PAD_PX, pt.y - POI_QUERY_PAD_PX],
      [pt.x + POI_QUERY_PAD_PX, pt.y + POI_QUERY_PAD_PX],
    ];
    // Deliberately unfiltered by layer id: those differ between the light and
    // dark styles, but both carry POI labels in a `poi_label` source layer.
    const features = map.queryRenderedFeatures(box) as unknown as QueriedFeature[];
    const name = features.find(f => f.sourceLayer === 'poi_label' && f.properties?.name)?.properties?.name;
    return typeof name === 'string' ? name : undefined;
  } catch {
    // queryRenderedFeatures throws while a style is mid-swap; a missing hint
    // costs nothing, so never let it break the pick itself.
    return undefined;
  }
}

interface Props {
  places: Place[];
  selectedPlace: Place | null;
  activeTags: string[];
  /**
   * Whether the map is the surface being looked at. It stays MOUNTED behind
   * the list view and the outliner — unmounting destroys the mapbox instance
   * and every toggle back would re-download the style and lose the viewport —
   * so "rendered" and "visible" are different questions, and flying to a place
   * is only meaningful when the answer to the second one is yes.
   */
  visible?: boolean;
  allTags: Tag[];
  onSelectPlace: (place: Place) => void;
  // Long-press / right-click on empty map — omit to disable pin dropping.
  onPickPoint?: (point: PickedPoint) => void;
  // The provisional pin shown while the "add here" sheet is open.
  pendingPoint?: PickedPoint | null;
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

export function MapView({ places, selectedPlace, activeTags, allTags, onSelectPlace, onPickPoint, pendingPoint, visible = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<Map<string, { marker: mapboxgl.Marker; anchor: string }>>(new Map());
  const didFitRef = useRef(false);
  // Latest route geometry, whatever the style lifecycle is doing: setStyle
  // (OS light/dark switch) wipes custom sources, and the styledata handler
  // must be able to re-apply the *data*, not just re-add empty layers —
  // otherwise the visited route vanishes at sunset when phones flip to dark.
  const routeDataRef = useRef<RouteFeatureCollection>(EMPTY_ROUTE);

  const applyRouteData = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    ensureRouteLayers(map);
    (map.getSource(ROUTE_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined)?.setData(routeDataRef.current);
  }, []);

  // Keep refs to the latest props so marker click handlers never go stale
  const placesRef = useRef(places);
  placesRef.current = places;
  const onSelectPlaceRef = useRef(onSelectPlace);
  onSelectPlaceRef.current = onSelectPlace;
  const onPickPointRef = useRef(onPickPoint);
  onPickPointRef.current = onPickPoint;

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
    // source/layers — re-add them AND re-apply the current route data every
    // time the style finishes (re)loading
    const map = mapRef.current;
    const onStyleData = () => applyRouteData();
    map.on('styledata', onStyleData);

    // ---- Long-press / right-click to drop a pin ----
    // Hand-rolled rather than leaning on `contextmenu` alone: iOS Safari
    // doesn't raise that event for a long press on the canvas, so touch
    // devices would otherwise have no gesture at all.
    const canvas = map.getCanvasContainer();
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    let pressStart: { x: number; y: number } | null = null;
    let lastPickAt = 0;

    const cancelPress = () => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = null;
      pressStart = null;
    };

    const firePick = (clientX: number, clientY: number) => {
      // Nothing here — not the haptic, not the swallowed context menu — may
      // happen when the caller didn't ask for pin dropping (the shared
      // read-only trip view renders this map without onPickPoint).
      const onPick = onPickPointRef.current;
      if (!onPick) return;
      const now = Date.now();
      if (now - lastPickAt < PICK_DEDUPE_MS) return;
      lastPickAt = now;
      const rect = canvas.getBoundingClientRect();
      const pt = new mapboxgl.Point(clientX - rect.left, clientY - rect.top);
      // .wrap() is essential, not cosmetic: renderWorldCopies is on by default
      // and the map opens at zoom 2, so several copies of the world are on
      // screen. unproject deliberately doesn't wrap, so a press on the copy
      // right of the prime meridian yields lng ≈ 362 — which the places table's
      // places_coords_bounded CHECK rejects, failing the insert at the very end
      // of the flow with only a generic toast.
      const lngLat = map.unproject(pt).wrap();
      // Confirm the press landed — without it a long press feels like nothing
      // happened until the sheet animates in.
      navigator.vibrate?.(15);
      onPick({
        lat: lngLat.lat,
        lng: lngLat.lng,
        hintName: renderedPoiName(map, pt),
      });
    };

    // A press that starts on an existing pin belongs to that pin.
    const onMarker = (target: EventTarget | null) =>
      !!(target as HTMLElement | null)?.closest?.('.mapboxgl-marker');

    const onTouchStart = (e: TouchEvent) => {
      cancelPress();
      if (!onPickPointRef.current) return;
      // Two fingers is a pinch-zoom, not a press.
      if (e.touches.length !== 1 || onMarker(e.target)) return;
      const t = e.touches[0];
      pressStart = { x: t.clientX, y: t.clientY };
      pressTimer = setTimeout(() => {
        pressTimer = null;
        if (pressStart) firePick(pressStart.x, pressStart.y);
      }, LONG_PRESS_MS);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!pressTimer || !pressStart) return;
      const t = e.touches[0];
      if (Math.hypot(t.clientX - pressStart.x, t.clientY - pressStart.y) > LONG_PRESS_MOVE_PX) {
        cancelPress();
      }
    };

    const onContextMenu = (e: MouseEvent) => {
      // Only swallow the browser's own menu when we're actually replacing it
      // with something. On the read-only shared view there's no pick to offer,
      // so the user keeps "Open in new tab", "Inspect" and their extensions.
      if (!onPickPointRef.current || onMarker(e.target)) return;
      // We provide the action a right-click would otherwise offer, and on
      // Android this suppresses the OS text-selection menu over the canvas.
      e.preventDefault();
      cancelPress();
      firePick(e.clientX, e.clientY);
    };

    canvas.addEventListener('touchstart', onTouchStart, { passive: true });
    canvas.addEventListener('touchmove', onTouchMove, { passive: true });
    canvas.addEventListener('touchend', cancelPress);
    canvas.addEventListener('touchcancel', cancelPress);
    canvas.addEventListener('contextmenu', onContextMenu);

    const markers = markersRef.current;
    return () => {
      darkQuery.removeEventListener('change', onSchemeChange);
      map.off('styledata', onStyleData);
      cancelPress();
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', cancelPress);
      canvas.removeEventListener('touchcancel', cancelPress);
      canvas.removeEventListener('contextmenu', onContextMenu);
      mapRef.current?.remove();
      mapRef.current = null;
      // The markers belong to the map instance that was just destroyed. Left
      // in the ref, a remount would "update" them instead of re-adding to the
      // fresh map — rendering zero pins (this is exactly what StrictMode's
      // dev double-mount hit).
      markers.clear();
      didFitRef.current = false;
    };
  }, [applyRouteData]);

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

  // Keyed on id + coordinates, not object identity: usePlaces re-creates the
  // place object on every optimistic update and server confirm, and flying on
  // identity yanked the map back to the pin (twice) whenever the open place
  // was edited behind the sheet.
  const selId = selectedPlace?.id;
  const selLng = selectedPlace?.longitude;
  const selLat = selectedPlace?.latitude;
  //
  // Gated on visibility, and deferred rather than dropped: opening a place from
  // the list or the outliner used to fly the hidden map anyway, so you closed
  // the sheet, switched back, and found yourself parked on a coordinate with
  // nothing under it. Now the same tap lands you there when the map returns.
  //
  // Once per place, though. `visible` is in the deps so a deferred fly can
  // happen at all, and without this ref every return to the map re-flew and
  // re-zoomed to whatever was still selected — panning away to look at the
  // area, glancing at the outliner and coming back would snap the viewport
  // straight back to the pin. A pan is a deliberate act; the fly is a
  // courtesy, and the courtesy should not keep overruling it.
  const flownFor = useRef<string | null>(null);
  useEffect(() => {
    if (!selId) { flownFor.current = null; return; }
    if (!visible || selLng === undefined || selLat === undefined || !mapRef.current) return;
    if (flownFor.current === selId) return;
    flownFor.current = selId;
    mapRef.current.flyTo({
      center: [selLng, selLat],
      zoom: Math.max(mapRef.current.getZoom(), 13),
      duration: 600,
    });
  }, [visible, selId, selLng, selLat]);

  // Provisional pin for the point being added. Coordinates as deps, not the
  // object: TripView re-creates it on every render of the open sheet, and on
  // identity the pin would be torn down and re-added (re-animating) each time.
  const pendingLng = pendingPoint?.lng;
  const pendingLat = pendingPoint?.lat;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || pendingLng === undefined || pendingLat === undefined) return;

    // Same three-layer shape as the real markers, and for the same reason:
    // Mapbox owns the outer element's transform (it positions the marker with
    // an inline transform), and a CSS animation on that element would beat the
    // inline style and rip the pin to the canvas origin for the animation's
    // duration — then leave it unrotated once the inline style won again.
    const outer = document.createElement('div');
    const drop = document.createElement('div');
    drop.className = 'map-pending-pin-drop';
    const inner = document.createElement('div');
    inner.className = 'map-pending-pin';
    drop.appendChild(inner);
    outer.appendChild(drop);
    const marker = new mapboxgl.Marker({ element: outer, anchor: 'bottom' })
      .setLngLat([pendingLng, pendingLat])
      .addTo(map);

    // Lift the point clear of the sheet that's about to cover the lower half,
    // without changing zoom — the user chose this spot by looking at it.
    map.easeTo({ center: [pendingLng, pendingLat], offset: [0, -110], duration: 400 });

    return () => { marker.remove(); };
  }, [pendingLng, pendingLat]);

  // Fit bounds once on initial load — never yank the viewport on add/remove.
  // Extra bottom padding so markers don't land under the floating bottom
  // nav, which overlays the now-full-bleed map rather than sitting beside it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || places.length === 0 || didFitRef.current) return;
    didFitRef.current = true;
    const bounds = new mapboxgl.LngLatBounds();
    places.forEach(p => bounds.extend([p.longitude, p.latitude]));
    map.fitBounds(bounds, {
      padding: { top: 80, bottom: 170, left: 80, right: 80 },
      maxZoom: 13,
      duration: 800,
    });
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

  // This effect only computes and stashes route data; applying it is shared
  // with the styledata handler, so a style swap mid-fetch can't drop it (the
  // old `map.once('load', …)` guard never fired after the initial load).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (visitedPlaces.length < 2) {
      routeDataRef.current = EMPTY_ROUTE;
      if (map.isStyleLoaded()) applyRouteData();
      return;
    }

    let cancelled = false;
    const points: [number, number][] = visitedPlaces.map(p => [p.longitude, p.latitude]);

    buildVisitedRouteGeoJSON(points).then(geojson => {
      if (cancelled) return;
      routeDataRef.current = geojson;
      // If the style is still loading (initial or mid-swap), the styledata
      // handler applies routeDataRef when it lands.
      if (map.isStyleLoaded()) applyRouteData();
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitedKey]);

  return <div ref={containerRef} className="map-container" />;
}
