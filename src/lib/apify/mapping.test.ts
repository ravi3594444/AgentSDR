import { describe, expect, test } from "bun:test";
import {
  apifyAllowance,
  hashtagsFor,
  looksExhausted,
  mentionsPlace,
  placesFromMapsItems,
  postsFromHashtagItems,
  profilesFromItems,
  runOutcome,
} from "./mapping";

const base = { monthlyBudgetUsd: 10, maxChargePerRunUsd: 2, spentThisMonthUsd: 0, reservedUsd: 0, openRuns: 0, account: { maxMonthlyUsageUsd: 50, monthlyUsageUsd: 5 } };

describe("apifyAllowance", () => {
  test("a run may spend its per-run cap while budget and account allowance last", () => {
    expect(apifyAllowance(base)).toEqual({ ok: true, maxChargeUsd: 2 });
  });

  test("the cap shrinks to what is left of the owner's budget or the account's allowance", () => {
    expect(apifyAllowance({ ...base, spentThisMonthUsd: 8.5 })).toEqual({ ok: true, maxChargeUsd: 1.5 });
    expect(apifyAllowance({ ...base, reservedUsd: 9 })).toEqual({ ok: true, maxChargeUsd: 1 });
    expect(apifyAllowance({ ...base, account: { maxMonthlyUsageUsd: 50, monthlyUsageUsd: 49.3 } })).toEqual({ ok: true, maxChargeUsd: 0.7 });
  });

  test("the owner's budget used up: exhausted, nothing starts", () => {
    expect(apifyAllowance({ ...base, spentThisMonthUsd: 10 })).toMatchObject({ ok: false, exhausted: true });
    expect(apifyAllowance({ ...base, spentThisMonthUsd: 6, reservedUsd: 4 })).toMatchObject({ ok: false, exhausted: true });
  });

  test("the Apify account's own limit reached: exhausted, and never raised", () => {
    const refused = apifyAllowance({ ...base, account: { maxMonthlyUsageUsd: 50, monthlyUsageUsd: 50 } });
    expect(refused).toMatchObject({ ok: false, exhausted: true });
    expect(refused.ok ? "" : refused.reason).toContain("never tops up");
  });

  test("fails closed when the account allowance cannot be read, and on too many open runs", () => {
    expect(apifyAllowance({ ...base, account: null })).toMatchObject({ ok: false, exhausted: false });
    expect(apifyAllowance({ ...base, openRuns: 2 })).toMatchObject({ ok: false, exhausted: false });
  });

  test("an account without a hard limit is bounded by the owner's budget alone", () => {
    expect(apifyAllowance({ ...base, account: { maxMonthlyUsageUsd: null, monthlyUsageUsd: null } })).toEqual({ ok: true, maxChargeUsd: 2 });
  });
});

describe("looksExhausted and runOutcome", () => {
  test("credit and limit refusals are exhaustion; other faults are not", () => {
    expect(looksExhausted({ httpStatus: 402 })).toBe(true);
    expect(looksExhausted({ httpStatus: 403, type: "not-enough-usage-to-run-paid-actor", message: "You do not have enough usage" })).toBe(true);
    expect(looksExhausted({ message: "ABORTED The run reached its maximum total charge (maxTotalChargeUsd)" })).toBe(true);
    expect(looksExhausted({ httpStatus: 404, type: "record-not-found", message: "Actor not found" })).toBe(false);
    expect(looksExhausted({ httpStatus: 500, message: "Internal error" })).toBe(false);
  });

  test("open, complete and cut-short runs", () => {
    for (const status of ["READY", "RUNNING", "TIMING-OUT", "ABORTING"]) expect(runOutcome(status)).toBe("running");
    expect(runOutcome("SUCCEEDED")).toBe("succeeded");
    for (const status of ["FAILED", "ABORTED", "TIMED-OUT"]) expect(runOutcome(status)).toBe("ended_early");
  });
});

describe("placesFromMapsItems", () => {
  test("maps the Google Maps Scraper's items, deduplicated by place id, nothing invented", () => {
    const { places, skipped } = placesFromMapsItems([
      { title: "Lotus Dental Clinic", placeId: "p1", categoryName: "Dentist", address: "Baner Rd, Pune", city: "Pune", countryCode: "IN", phone: "020 2553 1234", website: "https://lotusdental.example.in/", url: "https://maps.google.com/?cid=1", totalScore: 4.7, reviewsCount: 120 },
      { title: "Lotus Dental Clinic", placeId: "p1", phone: "020 2553 1234" },
      { title: "Smile Care", placeId: "p2", countryCode: "IN", permanentlyClosed: true },
      { placeId: "p3" },
      "not an object",
    ], "IN");
    expect(skipped).toBe(2);
    expect(places).toHaveLength(2);
    expect(places[0]).toMatchObject({ placeKey: "p1", name: "Lotus Dental Clinic", category: "Dentist", city: "Pune", country: "IN", phone: "+912025531234", website: "https://lotusdental.example.in/", mapsUrl: "https://maps.google.com/?cid=1", rating: 4.7, reviewCount: 120, emails: [] });
    expect(places[1]).toMatchObject({ placeKey: "p2", phone: null, website: null, closed: "permanently closed" });
  });
});

describe("Instagram mapping", () => {
  test("hashtags from the customer type and place, plus the owner's own", () => {
    expect(hashtagsFor("dental clinics", "Pune, India")).toEqual(["punedental", "dentalpune", "dental"]);
    expect(hashtagsFor("bakers", "Mumbai", ["#HomeBakersMumbai"])).toEqual(["homebakersmumbai", "mumbaibaker", "bakermumbai", "baker"]);
  });

  test("posts keep their author; posts without one are skipped", () => {
    const posts = postsFromHashtagItems([
      { ownerUsername: "Sweet.Treats", url: "https://www.instagram.com/p/abc/", caption: "Fresh cakes in Pune", timestamp: "2026-10-10T10:00:00Z", locationName: "Pune", inputUrl: "https://www.instagram.com/explore/tags/punebaker/" },
      { url: "https://www.instagram.com/p/def/" },
      { ownerUsername: "bad name!" },
    ]);
    expect(posts).toEqual([{ username: "sweet.treats", url: "https://www.instagram.com/p/abc/", caption: "Fresh cakes in Pune", timestamp: "2026-10-10T10:00:00Z", locationName: "Pune", hashtag: "punebaker" }]);
  });

  test("profiles keep only what they publish", () => {
    const profiles = profilesFromItems([
      { username: "Sweet.Treats", fullName: "Sweet Treats", biography: "Cakes · Pune", externalUrl: "https://sweettreats.example.in", businessEmail: "orders@sweettreats.example.in", businessPhoneNumber: "+91 98765 43210", businessCategoryName: "Bakery" },
      { username: "quiet.one", private: true },
    ], "IN");
    expect(profiles.get("sweet.treats")).toMatchObject({ fullName: "Sweet Treats", website: "https://sweettreats.example.in", email: "orders@sweettreats.example.in", phone: "+919876543210", category: "Bakery", isPrivate: false });
    expect(profiles.get("quiet.one")).toMatchObject({ email: null, phone: null, website: null, isPrivate: true });
  });

  test("a place is known only when the post or profile names it", () => {
    expect(mentionsPlace("Pune, India", "Cakes in pune")).toBe(true);
    expect(mentionsPlace("Pune, India", "Best cakes!", null)).toBe(false);
  });
});
