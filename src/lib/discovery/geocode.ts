/**
 * Where a lead search looks: the owner's place name ("Baner, Pune") turned
 * into a point and an area (OpenStreetMap's Nominatim, free; see
 * geocode.server.ts), and that area split into tiles, because the scraper's
 * fast mode returns at most 20 places per search. Pure, so the arithmetic is
 * unit-tested.
 */

export type GeoArea = { lat: number; lon: number; south: number; north: number; west: number; east: number; label: string };
export type SearchTile = { lat: number; lon: number; radiusMeters: number; zoom: number };

/** Places one fast search returns at most (measured on the scraper, 2026-10). */
export const PLACES_PER_SEARCH = 20;
export const MAX_TILES = 9;
const MIN_RADIUS = 1_500;
const MAX_RADIUS = 25_000;
const EARTH_RADIUS = 6_371_000;

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(a));
}

/** Widest area one lead search covers usefully (half its diagonal): a large metro area or a small region. */
export const MAX_SEARCH_HALF_DIAGONAL_KM = 150;

/**
 * Why `area` is too wide for one search, or null: up to 9 circles of about
 * 20 businesses each would sample a country or a large state at random.
 */
export function searchAreaProblem(area: GeoArea, where: string): string | null {
  const halfDiagonalKm = distanceMeters(area.south, area.west, area.north, area.east) / 2_000;
  if (halfDiagonalKm <= MAX_SEARCH_HALF_DIAGONAL_KM) return null;
  return `“${where}” is too wide for one search: Google Maps gives about ${PLACES_PER_SEARCH} businesses per area and one search covers at most ${MAX_TILES} areas. Do not ask the owner: choose its 3 largest cities for this kind of business yourself and call find_leads once per city now (up to 4 at once), then tell the owner which cities you chose.`;
}

/** A Google Maps zoom that shows roughly a circle of this radius. */
export function zoomForRadius(radiusMeters: number): number {
  if (radiusMeters <= 2_000) return 15;
  if (radiusMeters <= 4_000) return 14;
  if (radiusMeters <= 8_000) return 13;
  if (radiusMeters <= 16_000) return 12;
  return 11;
}

/**
 * Tiles covering the area: one for a small place, a grid of up to 3×3 for
 * a city, as many as the wanted results need (20 per tile). Each tile's
 * radius reaches its corners, so neighbours overlap a little; duplicates
 * are merged later by place.
 */
export function searchTiles(area: GeoArea, maxResults: number): SearchTile[] {
  const wanted = Math.min(MAX_TILES, Math.max(1, Math.ceil(maxResults / PLACES_PER_SEARCH)));
  const halfDiagonal = distanceMeters(area.south, area.west, area.north, area.east) / 2;
  if (wanted === 1 || halfDiagonal <= MIN_RADIUS * 1.5) {
    const radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, halfDiagonal));
    return [{ lat: area.lat, lon: area.lon, radiusMeters: radius, zoom: zoomForRadius(radius) }];
  }
  const side = wanted <= 4 ? 2 : 3;
  const latStep = (area.north - area.south) / side;
  const lonStep = (area.east - area.west) / side;
  const tiles: SearchTile[] = [];
  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      const lat = area.south + latStep * (row + 0.5);
      const lon = area.west + lonStep * (col + 0.5);
      const radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, distanceMeters(lat, lon, lat + latStep / 2, lon + lonStep / 2)));
      tiles.push({ lat, lon, radiusMeters: radius, zoom: zoomForRadius(radius) });
    }
  }
  // The centre tile first: the most likely matches, if the search stops early.
  tiles.sort((a, b) => distanceMeters(a.lat, a.lon, area.lat, area.lon) - distanceMeters(b.lat, b.lon, area.lat, area.lon));
  return tiles.slice(0, wanted);
}

/** A Nominatim search result, read defensively. */
export function parseNominatim(body: unknown): GeoArea | null {
  if (!Array.isArray(body) || !body.length) return null;
  const first = body[0] as { lat?: unknown; lon?: unknown; boundingbox?: unknown; display_name?: unknown };
  const lat = Number(first.lat);
  const lon = Number(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const box = Array.isArray(first.boundingbox) ? first.boundingbox.map(Number) : [];
  const [south, north, west, east] = box.length === 4 && box.every(Number.isFinite)
    ? box as [number, number, number, number]
    : [lat - 0.02, lat + 0.02, lon - 0.02, lon + 0.02];
  return { lat, lon, south, north, west, east, label: typeof first.display_name === "string" ? first.display_name : `${lat},${lon}` };
}
