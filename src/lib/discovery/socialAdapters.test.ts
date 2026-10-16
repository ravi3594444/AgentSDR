import { describe, expect, test } from "bun:test";
import { configuredSocialAdapters, metaGraphHashtagAdapter, normalizeHashtag } from "./socialAdapters";

// Meta's documented response shapes (ig_hashtag_search, recent_media), trimmed.
function fakeGraph(responses: Record<string, { status: number; body: unknown }>) {
  const calls: URL[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    const key = url.pathname.split("/").slice(2).join("/");
    const response = responses[key] ?? { status: 404, body: { error: { message: "Unknown path", code: 803 } } };
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("metaGraphHashtagAdapter", () => {
  test("searches the hashtag id, then its recent media, with the documented parameters", async () => {
    const { calls, fetchImpl } = fakeGraph({
      ig_hashtag_search: { status: 200, body: { data: [{ id: "17841562498105353" }] } },
      "17841562498105353/recent_media": {
        status: 200,
        body: {
          data: [
            { id: "18013", caption: "Need a dentist in Baner? #punedentist", media_type: "IMAGE", permalink: "https://www.instagram.com/p/C9xYz12AbCd/", timestamp: "2026-10-15T08:00:00+0000", like_count: 12, comments_count: 3 },
            { caption: "no id, dropped" },
          ],
          paging: { cursors: { after: "x" } },
        },
      },
    });
    const adapter = metaGraphHashtagAdapter({ accessToken: "token-1", instagramUserId: "1784140", fetchImpl });
    expect(adapter.configured()).toBe(true);
    const result = await adapter.searchHashtag("#PuneDentist");
    expect(result.hashtagId).toBe("17841562498105353");
    expect(result.media).toEqual([{ id: "18013", caption: "Need a dentist in Baner? #punedentist", mediaType: "IMAGE", permalink: "https://www.instagram.com/p/C9xYz12AbCd/", timestamp: "2026-10-15T08:00:00+0000", likeCount: 12, commentsCount: 3 }]);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.origin + calls[0]!.pathname).toBe("https://graph.facebook.com/v23.0/ig_hashtag_search");
    expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({ user_id: "1784140", q: "punedentist", access_token: "token-1" });
    expect(calls[1]!.pathname).toBe("/v23.0/17841562498105353/recent_media");
    expect(Object.fromEntries(calls[1]!.searchParams)).toEqual({ user_id: "1784140", fields: "id,caption,media_type,permalink,timestamp,like_count,comments_count", limit: "50", access_token: "token-1" });
  });

  test("an unknown hashtag returns nothing without a second call; Meta's errors are reported", async () => {
    const none = fakeGraph({ ig_hashtag_search: { status: 200, body: { data: [] } } });
    expect(await metaGraphHashtagAdapter({ accessToken: "t", instagramUserId: "1", fetchImpl: none.fetchImpl }).searchHashtag("nothinghere")).toEqual({ hashtagId: null, media: [] });
    expect(none.calls).toHaveLength(1);

    const limited = fakeGraph({ ig_hashtag_search: { status: 400, body: { error: { message: "You have reached the limit of 30 unique hashtags", code: 24 } } } });
    await expect(metaGraphHashtagAdapter({ accessToken: "t", instagramUserId: "1", fetchImpl: limited.fetchImpl }).searchHashtag("x")).rejects.toThrow("30 unique hashtags");
  });

  test("refuses what Meta would refuse, before any call", async () => {
    const { calls, fetchImpl } = fakeGraph({});
    await expect(metaGraphHashtagAdapter({ accessToken: "t", instagramUserId: "1", fetchImpl }).searchHashtag("two words")).rejects.toThrow("not a hashtag");
    const empty = metaGraphHashtagAdapter({ accessToken: " ", instagramUserId: "1", fetchImpl });
    expect(empty.configured()).toBe(false);
    await expect(empty.searchHashtag("dentist")).rejects.toThrow("no access token");
    expect(calls).toHaveLength(0);
    expect(normalizeHashtag("##Zahnarzt_München")).toBe("zahnarzt_münchen");
  });
});

describe("configuredSocialAdapters", () => {
  test("nothing is configured: there is no configuration source yet", () => {
    expect(configuredSocialAdapters()).toEqual([]);
  });
});
