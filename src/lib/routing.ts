const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string;

export interface RouteFeature {
  type: 'Feature';
  properties: { real: boolean };
  geometry: { type: 'LineString'; coordinates: [number, number][] };
}

export interface RouteFeatureCollection {
  type: 'FeatureCollection';
  features: RouteFeature[];
}

// Mapbox Directions only knows road/path networks — it has no concept of
// flights or ferries. A leg between, say, a mainland city and an island
// (or two different countries) will come back with no route at all. In
// that case the caller gets `null` and should fall back to a straight
// line rather than pretending a road exists.
async function fetchRoadRoute(from: [number, number], to: [number, number]): Promise<[number, number][] | null> {
  const coords = `${from[0]},${from[1]};${to[0]},${to[1]}`;
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.[0]) return null;
    return data.routes[0].geometry.coordinates as [number, number][];
  } catch {
    return null;
  }
}

// One line segment per consecutive pair of ordered points — a real road
// route where Mapbox can compute one, a straight line (marked `real:
// false` so it can be styled dashed) where it can't.
export async function buildVisitedRouteGeoJSON(points: [number, number][]): Promise<RouteFeatureCollection> {
  const features: RouteFeature[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    const road = await fetchRoadRoute(from, to);
    features.push({
      type: 'Feature',
      properties: { real: !!road },
      geometry: { type: 'LineString', coordinates: road ?? [from, to] },
    });
  }
  return { type: 'FeatureCollection', features };
}
