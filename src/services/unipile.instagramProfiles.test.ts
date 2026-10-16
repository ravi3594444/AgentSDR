import { describe, expect, test } from "bun:test";
import { instagramCommentsFrom, instagramPostFrom, instagramProfileFrom } from "./unipile.instagramProfiles";

describe("Instagram reads for discovery", () => {
  test("a profile: the SDK's declared fields, and a website under any of its names", () => {
    const profile = instagramProfileFrom({
      object: "UserProfile", provider: "INSTAGRAM", pk: 4211, username: "Lotus.Dental", full_name: "Lotus Dental Care",
      biography: "Smiles in Baner", is_business: true, is_private: false, external_url: "https://lotus.example.in/",
    }, "lotus.dental");
    expect(profile).toEqual({
      username: "lotus.dental", providerId: "4211", fullName: "Lotus Dental Care", biography: "Smiles in Baner",
      website: "https://lotus.example.in/", publicEmail: null, publicPhone: null, isBusiness: true, isPrivate: false,
    });
    expect(instagramProfileFrom({ websites: ["https://a.example"] }, "a").website).toBe("https://a.example");
    expect(instagramProfileFrom({ bio_links: [{ url: "https://b.example" }] }, "b").website).toBe("https://b.example");
    expect(instagramProfileFrom({ public_phone_country_code: "91", public_phone_number: "9822012345" }, "c").publicPhone).toBe("+919822012345");
    expect(instagramProfileFrom(null, "d")).toMatchObject({ username: "d", website: null, fullName: null });
  });

  test("a post's id for its comments, and its author", () => {
    expect(instagramPostFrom({ object: "Post", provider_id: "3456_789", id: "C9xYz12AbCd", author: { username: "Lotus.Dental" } })).toEqual({ providerId: "3456_789", text: null, authorUsername: "lotus.dental" });
    expect(instagramPostFrom({ social_id: "999", text: "Open today" })).toEqual({ providerId: "999", text: "Open today", authorUsername: null });
    expect(instagramPostFrom({ text: "no id" })).toBeNull();
  });

  test("comments with their authors, as given; empty ones dropped", () => {
    expect(instagramCommentsFrom({
      object: "CommentList",
      items: [
        { object: "Comment", id: "c1", text: "need a dentist near Baner, any recommendation?", date: "2026-10-14T10:00:00.000Z", author: "Priya K", author_details: { id: "77", profile_url: "https://www.instagram.com/priya.k/" } },
        { object: "Comment", id: "c2", text: "😍🔥", date: "not a date", author: { name: "Rohit", username: "Rohit_S" }, author_details: {} },
        { object: "Comment", id: "c3", text: "   ", author: "x", author_details: {} },
      ],
      cursor: null,
    })).toEqual([
      { id: "c1", text: "need a dentist near Baner, any recommendation?", date: "2026-10-14T10:00:00.000Z", authorName: "Priya K", authorUsername: "priya.k", authorProfileUrl: "https://www.instagram.com/priya.k/" },
      { id: "c2", text: "😍🔥", date: null, authorName: "Rohit", authorUsername: "rohit_s", authorProfileUrl: null },
    ]);
    expect(instagramCommentsFrom({})).toEqual([]);
  });
});
