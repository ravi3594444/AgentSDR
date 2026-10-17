import { describe, expect, test } from "bun:test";

import { summarizeSources } from "./results";

describe("summarizeSources", () => {
  test("groups a source's rows into found, contactable and left out", () => {
    const summary = summarizeSources([
      { source: "google_maps", status: "eligible", count: 150 },
      { source: "google_maps", status: "excluded", count: 50 },
      { source: "list", status: "eligible", count: 20 },
    ]);
    expect(summary).toEqual([
      { source: "google_maps", label: "Google Maps listing", found: 200, contactable: 150, leftOut: 50 },
      { source: "list", label: "Your list", found: 20, contactable: 20, leftOut: 0 },
    ]);
  });

  test("ranks by how many were found", () => {
    const summary = summarizeSources([
      { source: "google_maps", status: "eligible", count: 10 },
      { source: "web_search", status: "eligible", count: 40 },
    ]);
    expect(summary.map((s) => s.source)).toEqual(["web_search", "google_maps"]);
  });

  test("one source that found nothing usable is still shown, not hidden", () => {
    const summary = summarizeSources([{ source: "apify_instagram", status: "excluded", count: 12 }]);
    expect(summary[0]).toMatchObject({ found: 12, contactable: 0, leftOut: 12 });
  });

  test("no rows is no sources", () => {
    expect(summarizeSources([])).toEqual([]);
  });

  test("an unknown source still has a readable label", () => {
    const summary = summarizeSources([{ source: "mystery_source", status: "eligible", count: 1 }]);
    expect(summary[0]!.label).toBe("Mystery source");
  });
});
