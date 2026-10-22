import { describe, expect, test } from "bun:test";
import { APIFY_LIMITS } from "./catalog";
import {
  apifyAllowance,
  apifyRefusalIsBusy,
  facebookSearchInput,
  linkedinCompanySearchInput,
  MAX_HASHTAGS,
  placesFromFacebookItems,
  placesFromLinkedinCompanyItems,
  usernamesFromSearchItems,
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

  test("an allowance that could not be read leaves the owner's budget and per-run cap in charge; too many open runs wait", () => {
    expect(apifyAllowance({ ...base, account: null })).toEqual({ ok: true, maxChargeUsd: 2 });
    expect(apifyAllowance({ ...base, account: null, spentThisMonthUsd: 9.5 })).toEqual({ ok: true, maxChargeUsd: 0.5 });
    expect(apifyAllowance({ ...base, account: null, spentThisMonthUsd: 10 })).toMatchObject({ ok: false, exhausted: true });
    expect(apifyAllowance({ ...base, openRuns: APIFY_LIMITS.openRuns - 1 })).toEqual({ ok: true, maxChargeUsd: 2 });
    expect(apifyAllowance({ ...base, openRuns: APIFY_LIMITS.openRuns })).toMatchObject({ ok: false, exhausted: false, slotsFull: true });
    expect(apifyAllowance({ ...base, monthlyBudgetUsd: 0.01 })).not.toHaveProperty("slotsFull");
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

  test("an account running as many Actors as its plan's memory allows is busy (a wait), not out of credit", () => {
    const memory = { httpStatus: 402, type: "actor-memory-limit-exceeded", message: "By launching this job you will exceed the memory limit of 8192MB for all your Actor runs and builds (currently used: 8192MB, requested: 1024MB)." };
    expect(apifyRefusalIsBusy(memory)).toBe(true);
    expect(looksExhausted(memory)).toBe(false);
    expect(apifyRefusalIsBusy({ httpStatus: 402, message: "You have reached the maximum number of concurrent Actor runs" })).toBe(true);
    // A 402 about credit stays exhaustion.
    const credit = { httpStatus: 402, type: "not-enough-usage-to-run-paid-actor", message: "You do not have enough usage left; the memory limit is not the problem" };
    expect(apifyRefusalIsBusy(credit)).toBe(false);
    expect(looksExhausted(credit)).toBe(true);
    expect(apifyRefusalIsBusy({ httpStatus: 404, type: "record-not-found", message: "Actor not found" })).toBe(false);
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

  test("with no place, the model's hashtags and the kind alone; up to MAX_HASHTAGS reach the Actor", () => {
    expect(hashtagsFor("home bakers", "", ["#cakesofinstagram", "customcakes"])).toEqual(["cakesofinstagram", "customcakes", "homebaker"]);
    const many = Array.from({ length: 30 }, (_, index) => `tag${index}xyz`);
    expect(hashtagsFor("bakers", "Mumbai", many)).toHaveLength(MAX_HASHTAGS);
    expect(hashtagsFor("bakers", "Mumbai", many).slice(0, 3)).toEqual(["tag0xyz", "tag1xyz", "tag2xyz"]);
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

describe("social search inputs", () => {
  test("Facebook pages by keyword: with a place, or with none (locations empty), always the pages search", () => {
    expect(facebookSearchInput({ what: "dentists", where: "Austin, TX" }, 40)).toEqual({ categories: ["dentists"], locations: ["Austin, TX"], searchType: "pages", resultsLimit: 40 });
    expect(facebookSearchInput({ what: "vegan bakeries", where: "" }, 25)).toEqual({ categories: ["vegan bakeries"], locations: [], searchType: "pages", resultsLimit: 25 });
  });

  test("LinkedIn companies by keyword, with locations only when a place is given", () => {
    expect(linkedinCompanySearchInput({ what: "logistics", where: "Germany" }, 30)).toEqual({ searchQuery: "logistics", locations: ["Germany"], scraperMode: "full", maxItems: 30 });
    expect(linkedinCompanySearchInput({ what: "logistics", where: "" }, 30)).toEqual({ searchQuery: "logistics", scraperMode: "full", maxItems: 30 });
  });
});

describe("social sources", () => {
  test("Facebook pages become places with the contacts the page publishes", () => {
    // From apify/facebook-search-scraper's documented output (2026-10-16).
    const { places, skipped } = placesFromFacebookItems([
      { facebookUrl: "https://www.facebook.com/MKDCLangley", categories: ["Page", "Kitchen & bathroom contractor"], title: "Merit Kitchens Design Centre Langley | Langley BC", address: "Unit 150 - 19888 Langley Bypass, Langley, BC", pageId: "100063562495135", pageName: "MKDCLangley", pageUrl: "https://www.facebook.com/MKDCLangley", phone: "+1 604-532-7197", email: "langley@merit-kitchens.com", website: "meritdesignlangley.com", ratingCount: 8 },
      { facebookUrl: "https://www.facebook.com/MKDCLangley", title: "duplicate", pageId: "100063562495135" },
      { title: "no page url" },
    ], "US");
    expect(skipped).toBe(1);
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ placeKey: "facebook:100063562495135", category: "Kitchen & bathroom contractor", phone: "+16045327197", emails: ["langley@merit-kitchens.com"], mapsUrl: "https://www.facebook.com/MKDCLangley", domain: "meritdesignlangley.com" });
  });
  test("LinkedIn companies become places whose contacts come from their website", () => {
    const { places, skipped } = placesFromLinkedinCompanyItems([
      { id: "213520", name: "Acme Robotics", linkedinUrl: "https://www.linkedin.com/company/acme-robotics/", website: "https://acmerobotics.example", industries: [{ name: "Industrial Automation" }], headquarter: { city: "Austin", country: "US", line1: "1 Main St" } },
      { name: "Not a company page", linkedinUrl: "https://www.linkedin.com/in/someone" },
    ]);
    expect(skipped).toBe(1);
    expect(places[0]).toMatchObject({ placeKey: "linkedin:213520", category: "Industrial Automation", city: "Austin", address: "1 Main St, Austin, US", emails: [], domain: "acmerobotics.example", linkedinUrl: "https://www.linkedin.com/company/acme-robotics/" });
  });
  test("Instagram search results give usernames, from a user search or a place's business profile", () => {
    expect(usernamesFromSearchItems([
      { username: "BrightSmileDental" },
      { name: "Bakeshop Praha", ig_business: { profile: { username: "bakeshop.praha" } } },
      { username: "brightsmiledental" },
      { username: "not valid!" },
      { ig_business: { profile: null } },
    ])).toEqual(["brightsmiledental", "bakeshop.praha"]);
  });
});
