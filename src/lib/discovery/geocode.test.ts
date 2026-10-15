import { describe, expect, test } from "bun:test";
import { MAX_TILES, parseNominatim, searchTiles, zoomForRadius } from "./geocode";

const baner = parseNominatim([{ lat: "18.5589937", lon: "73.7845232", boundingbox: ["18.5389937", "18.5789937", "73.7645232", "73.8045232"], display_name: "Baner, Pune" }])!;
const pune = parseNominatim([{ lat: "18.5213738", lon: "73.8545071", boundingbox: ["18.3713738", "18.6713738", "73.7045071", "74.0045071"], display_name: "Pune" }])!;

describe("geocode", () => {
  test("parseNominatim reads the point, box and label, or null", () => {
    expect(baner).toMatchObject({ lat: 18.5589937, lon: 73.7845232, south: 18.5389937, north: 18.5789937, label: "Baner, Pune" });
    expect(parseNominatim([])).toBeNull();
    expect(parseNominatim({ error: "x" })).toBeNull();
    expect(parseNominatim([{ lat: "x", lon: "1" }])).toBeNull();
  });

  test("one tile covers a small search; more results mean more tiles, at most nine", () => {
    expect(searchTiles(baner, 20)).toHaveLength(1);
    expect(searchTiles(pune, 40)).toHaveLength(2);
    expect(searchTiles(pune, 200)).toHaveLength(MAX_TILES);
  });

  test("tiles stay inside the area, nearest the centre first, with a sane radius and zoom", () => {
    const tiles = searchTiles(pune, 200);
    for (const tile of tiles) {
      expect(tile.lat).toBeGreaterThan(pune.south);
      expect(tile.lat).toBeLessThan(pune.north);
      expect(tile.radiusMeters).toBeGreaterThanOrEqual(1_500);
      expect(tile.radiusMeters).toBeLessThanOrEqual(25_000);
    }
    expect(Math.abs(tiles[0]!.lat - pune.lat)).toBeLessThan(0.06);
    expect(zoomForRadius(1_500)).toBe(15);
    expect(zoomForRadius(30_000)).toBe(11);
  });
});
