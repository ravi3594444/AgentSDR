import { describe, expect, test } from "bun:test";
import { BRIGHTDATA_PLATFORMS } from "@/lib/brightdata/catalog";
import { MAX_SOCIAL_URLS, normalizeSocialCriteria, socialPhrase, socialQueries, type SocialResearchCriteria } from "./socialResearch";

const limits = { maxRecordsPerSearch: 60 };
const criteria = (input: Parameters<typeof normalizeSocialCriteria>[0]): SocialResearchCriteria => {
  const result = normalizeSocialCriteria(input, limits);
  if ("error" in result) throw new Error(result.error);
  return result;
};

describe("what research_social_sources asks for", () => {
  test("no platforms named: every platform; no maxResults: the organization's records per search", () => {
    const result = criteria({ customers: "wedding photographers", where: "Austin" });
    expect(result.platforms).toEqual([...BRIGHTDATA_PLATFORMS]);
    expect(result.maxResults).toBe(60);
    expect(result.since).toBe("past_year");
    // The owner's setting stays the most a job collects.
    expect(criteria({ customers: "x", maxResults: 1_000 }).maxResults).toBe(60);
    expect(criteria({ customers: "x", maxResults: 1 }).maxResults).toBe(5);
    expect(normalizeSocialCriteria({ customers: "x" }, { maxRecordsPerSearch: 120 })).toMatchObject({ maxResults: 120 });
  });

  test("who to find is optional when a need or keywords say it", () => {
    const need = criteria({ need: "looking for a wedding photographer" });
    expect(need.customers).toBe("");
    expect(socialQueries(need, "reddit")).toEqual(["looking for a wedding photographer"]);
    expect(socialQueries(need, "x")).toEqual(["site:x.com looking for a wedding photographer"]);
    const keywords = criteria({ keywords: ["a", "b", "c", "d", "e", "f", "g"].map((letter) => `phrase ${letter}`), platforms: ["reddit"] });
    expect(keywords.keywords).toHaveLength(6);
    expect(socialQueries(keywords, "reddit")).toHaveLength(4);
    expect(normalizeSocialCriteria({ where: "Austin" }, limits)).toEqual({ error: expect.stringContaining("say who to find") });
  });

  test("named platforms are kept; names it does not know are refused", () => {
    expect(criteria({ customers: "salons", platforms: ["instagram", "facebook", "tiktok"] }).platforms).toEqual(["instagram", "facebook"]);
    expect(normalizeSocialCriteria({ customers: "salons", platforms: ["tiktok"] }, limits)).toEqual({ error: expect.stringContaining("reddit, x, instagram or facebook") });
  });

  test("links the model found are read through the dataset that reads them; the rest are reported, never sent", () => {
    const result = criteria({
      urls: [
        "https://www.instagram.com/lotus.dental/",
        "https://instagram.com/lotus.dental",
        "https://m.facebook.com/p/Lotus-Dental-Austin-100063456789012/",
        "https://x.com/LotusDental/status/1234567890123",
        "https://www.reddit.com/r/Dentists/comments/abc123/slug/",
        "https://www.facebook.com/groups/123",
        "https://example.com/team",
      ],
    });
    expect(result.urls).toEqual([
      { url: "https://www.instagram.com/lotus.dental/", dataset: "instagram_profiles", platform: "instagram" },
      { url: "https://www.facebook.com/p/Lotus-Dental-Austin-100063456789012/", dataset: "facebook_pages", platform: "facebook" },
      { url: "https://x.com/LotusDental/status/1234567890123", dataset: "x_posts", platform: "x" },
      { url: "https://www.reddit.com/r/Dentists/comments/abc123/slug/", dataset: "reddit_posts", platform: "reddit" },
    ]);
    expect(result.unreadableUrls).toEqual(["https://www.facebook.com/groups/123", "https://example.com/team"]);
    // Links only: their platforms, and nothing searched.
    expect(result.platforms).toEqual(["instagram", "facebook", "x", "reddit"]);
    expect(socialQueries(result, "instagram")).toEqual([]);
    expect(socialPhrase(result)).toBe("4 given links");
    // With a search too, the links' platforms join the ones named.
    expect(criteria({ customers: "dentists", platforms: ["reddit"], urls: ["https://www.instagram.com/lotus.dental/"] }).platforms).toEqual(["reddit", "instagram"]);
    // Only unreadable links and no words: refused with the links named.
    expect(normalizeSocialCriteria({ urls: ["https://example.com/team"] }, limits)).toEqual({ error: expect.stringContaining("https://example.com/team") });
  });

  test(`at most ${MAX_SOCIAL_URLS} links are read in one call; the others are named`, () => {
    const result = criteria({ urls: Array.from({ length: MAX_SOCIAL_URLS + 2 }, (_, index) => `https://x.com/account${index}`) });
    expect(result.urls).toHaveLength(MAX_SOCIAL_URLS);
    expect(result.unreadableUrls).toHaveLength(2);
    expect(result.unreadableUrls![0]).toContain(`at most ${MAX_SOCIAL_URLS} links`);
  });

  test("since sets Reddit's period; anything else is refused", () => {
    expect(criteria({ customers: "x", since: "past_week" }).since).toBe("past_week");
    expect(criteria({ customers: "x", since: "All time" }).since).toBe("all_time");
    expect(criteria({ customers: "x", since: "month" }).since).toBe("past_month");
    expect(normalizeSocialCriteria({ customers: "x", since: "yesterday" }, limits)).toEqual({ error: expect.stringContaining("since must be one of") });
  });
});
