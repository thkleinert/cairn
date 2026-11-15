import type { Place } from '../types';

// Handing a place off to a navigation app.
//
// Every option is a plain https link except the Android one, because those
// are the only links that work everywhere: Google Maps and Organic Maps links
// are universal links, so they open the app when it is installed and the
// website when it is not, and maps.apple.com does the same on Apple devices
// and falls back to the Apple Maps website elsewhere. A custom scheme like
// comgooglemaps:// does nothing at all without the app, and a web page cannot
// check for it first.
//
// The exception is `geo:`, which is Android's own "any map app" intent: the
// system shows a chooser of everything that can handle it (Organic Maps,
// OsmAnd, HERE, …). iOS has no equivalent and ignores the scheme, so it is
// only offered on Android.

export interface DirectionsOption {
  id: 'google' | 'apple' | 'organic' | 'geo';
  label: string;
  href: string;
}

export function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
}

export function directionsOptions(place: Pick<Place, 'name' | 'latitude' | 'longitude' | 'google_place_id'>): DirectionsOption[] {
  // Coordinates rather than the name or address as the destination: they are
  // what the trip's own map pins, so the route ends where the marker is. A
  // name search can land on a same-named place elsewhere, and a custom place
  // may not have an address at all.
  const ll = `${place.latitude},${place.longitude}`;
  const name = encodeURIComponent(place.name);

  const google = new URL('https://www.google.com/maps/dir/');
  google.searchParams.set('api', '1');
  google.searchParams.set('destination', ll);
  // With a place id Google routes to the place itself (the entrance, not the
  // centroid) and shows its card instead of bare coordinates.
  if (place.google_place_id) google.searchParams.set('destination_place_id', place.google_place_id);

  const apple = new URL('https://maps.apple.com/');
  apple.searchParams.set('daddr', ll);
  // Labels the destination; without it Apple Maps shows the coordinates.
  apple.searchParams.set('q', place.name);

  const options: DirectionsOption[] = [
    { id: 'google', label: 'Google Maps', href: google.toString() },
    { id: 'apple', label: 'Apple Maps', href: apple.toString() },
    { id: 'organic', label: 'Organic Maps', href: organicMapsUrl(place.latitude, place.longitude, place.name) },
  ];

  if (isAndroid()) {
    // `q=lat,lng(label)` drops a labelled pin; the bare `geo:lat,lng` prefix
    // alone only centres the map in most apps.
    options.push({ id: 'geo', label: 'Other map app…', href: `geo:${ll}?q=${ll}(${name})` });
  }

  return options;
}

// Organic Maps.
//
// Opens on the place rather than a route to it. The app's `om://route` call
// does exist, but it insists on both ends — it rejects a link without a start
// point instead of starting from where you are — and the only way to supply
// one is to ask for the user's location first. Organic Maps' own converter for
// Apple's geo-navigation links falls back to exactly this when no start is
// given; the place card it opens has "Route to" one tap away.
//
// An https://omaps.app link rather than om://. The domain is a registered
// universal link for the iOS app (and an app link on Android), so it opens
// the app when installed and a page with the place and store links when not —
// where om:// without the app would do nothing at all.
//
// In the app's compact "ge0" form, ported from libs/ge0/url_generator.cpp.
// omaps.app also accepts plain "lat,lon" now, but only since mid-2026; ge0 is
// what every installed version understands.

const GE0_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const GE0_COORD_BITS = 30;
const GE0_POINT_BYTES = 9;
/** Street level — close enough to see the entrance, wide enough to see where it is. */
const GE0_ZOOM = 16;

function ge0Lat(lat: number, max: number): number {
  const x = ((lat + 90) / 180) * max;
  return x < 0 ? 0 : x > max ? max : Math.round(x);
}

function ge0Lon(lon: number, max: number): number {
  // Into [-180, 180) first, as LonIn180180 does.
  const l = ((((lon + 180) % 360) + 360) % 360) - 180;
  const x = ((l + 180) / 360) * (max + 1) + 0.5;
  return x <= 0 || x >= max + 1 ? 0 : Math.floor(x);
}

/** The name as the app reads it back: spaces and underscores swapped, then escaped. */
function ge0Name(name: string): string {
  const swapped = name.replace(/[ _]/g, c => (c === ' ' ? '_' : ' '));
  // encodeURIComponent leaves !*'() alone; the app's encoder escapes them.
  return encodeURIComponent(swapped).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function organicMapsUrl(lat: number, lon: number, name: string): string {
  const max = (1 << GE0_COORD_BITS) - 1;
  const latI = ge0Lat(lat, max);
  const lonI = ge0Lon(lon, max);

  const zoomI = GE0_ZOOM <= 4 ? 0 : GE0_ZOOM >= 19.75 ? 63 : Math.floor((GE0_ZOOM - 4) * 4);
  let code = GE0_ALPHABET[zoomI];
  // Three bits of each coordinate per character, interleaved lat/lon.
  for (let i = 0, shift = GE0_COORD_BITS - 3; i < GE0_POINT_BYTES; i++, shift -= 3) {
    const a = (latI >> shift) & 7;
    const b = (lonI >> shift) & 7;
    code += GE0_ALPHABET[
      (((a >> 2) & 1) << 5) | (((b >> 2) & 1) << 4) | (((a >> 1) & 1) << 3) |
      (((b >> 1) & 1) << 2) | ((a & 1) << 1) | (b & 1)
    ];
  }

  const label = name.trim();
  return `https://omaps.app/${code}${label ? '/' + ge0Name(label) : ''}`;
}
