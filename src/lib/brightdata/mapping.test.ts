import { describe, expect, test } from "bun:test";
import { collectionKey, creditsUsed, errorKind, failureOf, progressOutcome, readRecords, reservedCredits } from "./mapping";
import { datasetForUrl, redditUserUrl, xProfileUrl } from "./urls";

/*
 * The records below keep the exact field names and shapes Bright Data
 * returned live on 2026-10-21 (Reddit keyword discovery, X profile,
 * Instagram profile error, Facebook page), with the people and text
 * replaced: the quirks are real (a commenter's user_url that is not a URL,
 * Facebook contacts nested under contact_and_basic_info), the content is not.
 */

const REDDIT_POST = {
  post_id: "t3_abc123",
  url: "https://www.reddit.com/r/Dentists/comments/abc123/how_do_clinics_handle_missed_calls/",
  user_posted: "frontdesk_fran",
  title: "How do clinics handle missed calls when the front desk is busy?",
  description: "We lose bookings every week because nobody can pick up. Looking for a service that answers calls for us.",
  num_comments: 10,
  date_posted: "2026-10-12T10:30:02.133Z",
  community_name: "Dentists",
  num_upvotes: 0,
  photos: null,
  videos: null,
  comments: [
    {
      comment: "We use an answering service, happy to share who.",
      url: "https://www.reddit.com/r/Dentists/comments/abc123/comment/c1/",
      user_commenting: "drsmile_owner",
      user_url: "https://www.reddit.com/svc/shreddit/comments/r/Dentists/undefined",
      date_of_comment: "2026-10-13T13:19:55.908Z",
      num_upvotes: 1,
      num_replies: 1,
      replies: [
        {
          comment: "Same problem here, any recommendations?",
          url: "https://www.reddit.com/r/Dentists/comments/abc123/comment/c2/",
          user_commenting: "smallclinic_sam",
          date_of_comment: "2026-10-13T14:00:00.000Z",
          replies: [],
        },
      ],
    },
    { comment: "[deleted]", url: null, user_commenting: "[deleted]" },
  ],
  community_url: "https://www.reddit.com/r/Dentists/",
  timestamp: "2026-10-21T07:01:14.218Z",
  input: { url: "https://www.reddit.com/r/Dentists/comments/abc123/how_do_clinics_handle_missed_calls/" },
  discovery_input: { keyword: "dental clinic front desk missed calls", date: "Past year", num_of_posts: 2, sort_by: "" },
};

const X_PROFILE = {
  x_id: "607080773",
  url: "https://x.com/LotusDental",
  id: "LotusDental",
  profile_name: "Lotus Dental Care",
  biography: "Family dentistry in Austin. Bookings: hello@lotusdental.example",
  is_verified: false,
  external_link: "http://www.lotusdental.example/",
  location: "Austin, TX",
  is_business_account: false,
  category_name: [],
  posts: [],
  timestamp: "2026-10-21T07:02:21.486Z",
  input: { url: "https://x.com/lotusdental", max_number_of_posts: 2 },
};

const INSTAGRAM_ERROR = {
  timestamp: "2026-10-21T07:04:25.163Z",
  input: { url: "https://www.instagram.com/nosuchaccount/" },
  error: "Profile isn't available",
  error_code: "dead_page",
};

const FACEBOOK_PAGE = {
  id: "100063504326716",
  url: "https://www.facebook.com/lotusdentalaustin",
  page_name: "Lotus Dental Austin",
  username: "lotusdentalaustin",
  primary_category: "Dentist & Dental Office",
  contact_and_basic_info: {
    categories: ["Dentist & Dental Office"],
    contact_info: { phones: ["+1 512-555-0142"], emails: ["frontdesk@lotusdental.example"], websites: ["https://lotusdental.example/"] },
  },
  followers: 198,
  timestamp: "2026-10-21T07:06:06.444Z",
  input: { url: "https://www.facebook.com/lotusdentalaustin" },
};

describe("Bright Data records → findings", () => {
  test("a Reddit post keeps its text, author, subreddit, times and nested comments", () => {
    const { findings, failures } = readRecords("reddit_posts", [REDDIT_POST]);
    expect(failures).toEqual([]);
    const [post, ...comments] = findings;
    expect(post).toMatchObject({
      platform: "reddit",
      kind: "post",
      url: REDDIT_POST.url,
      title: REDDIT_POST.title,
      community: "Dentists",
      postedAt: "2026-10-12T10:30:02.133Z",
      retrievedAt: "2026-10-21T07:01:14.218Z",
      author: { username: "frontdesk_fran", profileUrl: "https://www.reddit.com/user/frontdesk_fran/" },
      input: "dental clinic front desk missed calls",
    });
    expect(post!.text).toContain("Looking for a service");
    // A reply is kept; a deleted comment without a URL is not.
    expect(comments.map((comment) => comment.author?.username)).toEqual(["drsmile_owner", "smallclinic_sam"]);
    // The commenter's profile URL is built from the name, never Bright Data's malformed user_url.
    expect(comments[0]!.author!.profileUrl).toBe("https://www.reddit.com/user/drsmile_owner/");
    expect(comments[1]).toMatchObject({ kind: "comment", parentUrl: REDDIT_POST.url, text: "Same problem here, any recommendations?" });
  });

  test("an X profile publishes its website and the email written in its bio, nothing more", () => {
    const [profile] = readRecords("x_profiles", [X_PROFILE]).findings;
    expect(profile!.identity).toMatchObject({
      name: "Lotus Dental Care",
      username: "LotusDental",
      websites: ["http://www.lotusdental.example/"],
      emails: ["hello@lotusdental.example"],
      phones: [],
      location: "Austin, TX",
    });
  });

  test("a record for an input Bright Data could not read is a failure with its reason, not a finding", () => {
    const { findings, failures } = readRecords("instagram_profiles", [INSTAGRAM_ERROR]);
    expect(findings).toEqual([]);
    expect(failures).toEqual([{ input: "https://www.instagram.com/nosuchaccount/", code: "dead_page", reason: "Profile isn't available" }]);
    expect(failureOf(X_PROFILE)).toBeNull();
  });

  test("a Facebook page's contacts are read where Bright Data put them (nested), deduplicated", () => {
    const [page] = readRecords("facebook_pages", [FACEBOOK_PAGE, { ...FACEBOOK_PAGE, url: "https://www.facebook.com/other", emails: ["frontdesk@lotusdental.example"] }]).findings;
    expect(page!.identity).toMatchObject({
      name: "Lotus Dental Austin",
      category: "Dentist & Dental Office",
      emails: ["frontdesk@lotusdental.example"],
      phones: ["+1 512-555-0142"],
      websites: ["https://lotusdental.example/"],
    });
  });

  test("social links stay social links; link-in-bio pages count as websites", () => {
    const [profile] = readRecords("reddit_profiles", [{
      url: "https://www.reddit.com/user/drsmile_owner/",
      name: "drsmile_owner",
      description: "Practice owner",
      social_links: [{ url: "https://www.instagram.com/drsmile/" }, "https://linktr.ee/drsmile", "https://drsmile.example"],
      timestamp: "2026-10-21T08:00:00.000Z",
    }]).findings;
    expect(profile!.identity!.socialLinks).toEqual(["https://www.instagram.com/drsmile/"]);
    expect(profile!.identity!.websites).toEqual(["https://linktr.ee/drsmile", "https://drsmile.example"]);
  });

  test("an Instagram profile keeps its published email and its username", () => {
    const [profile] = readRecords("instagram_profiles", [{
      account: "lotusdental",
      full_name: "Lotus Dental",
      biography: "Smiles in Austin",
      external_url: "https://lotusdental.example",
      email_address: "Hello@LotusDental.example",
      profile_url: "https://www.instagram.com/lotusdental",
      timestamp: "2026-10-21T08:00:00.000Z",
    }]).findings;
    expect(profile!.identity).toMatchObject({ username: "lotusdental", emails: ["hello@lotusdental.example"], websites: ["https://lotusdental.example"] });
  });
});

describe("URLs sent to Bright Data", () => {
  test("only plain posts, profiles and pages are sent, in canonical form", () => {
    expect(datasetForUrl("https://old.reddit.com/r/Dentists/comments/abc123/slug/?utm=x")).toEqual({ dataset: "reddit_posts", url: "https://www.reddit.com/r/Dentists/comments/abc123/slug/", handle: null });
    expect(datasetForUrl("https://twitter.com/LotusDental/status/1234567890123")).toEqual({ dataset: "x_posts", url: "https://x.com/LotusDental/status/1234567890123", handle: "LotusDental" });
    expect(datasetForUrl("https://x.com/LotusDental")).toMatchObject({ dataset: "x_profiles", url: "https://x.com/LotusDental" });
    expect(datasetForUrl("https://www.instagram.com/p/Cabc123xyz/")).toMatchObject({ dataset: "instagram_posts" });
    expect(datasetForUrl("https://m.facebook.com/lotusdentalaustin/about")).toMatchObject({ dataset: "facebook_pages", url: "https://www.facebook.com/lotusdentalaustin" });
    expect(datasetForUrl("https://www.facebook.com/lotusdentalaustin/posts/pfbid0abc123")).toMatchObject({ dataset: "facebook_posts" });
    // A page's newer address, /p/<Name>-<id>/, is a page too; /p/ with no page id is not.
    expect(datasetForUrl("https://m.facebook.com/p/Lotus-Dental-Austin-100063456789012/?mibextid=x")).toEqual({ dataset: "facebook_pages", url: "https://www.facebook.com/p/Lotus-Dental-Austin-100063456789012/", handle: null });
    expect(datasetForUrl("https://www.facebook.com/p/Lotus-Dental")).toBeNull();
    expect(datasetForUrl("https://www.facebook.com/p/Lotus-Dental-Austin-100063456789012/photos")).toBeNull();
    // Searches, logins, groups, share links and other sites are never sent (each would be a billed failure).
    for (const url of ["https://x.com/search?q=dentist", "https://x.com/i/flow/login", "https://www.facebook.com/groups/123", "https://www.facebook.com/sharer.php?u=x", "https://www.reddit.com/r/Dentists/", "https://example.com/x.com", "not a url"]) {
      expect(datasetForUrl(url)).toBeNull();
    }
    expect(redditUserUrl("[deleted]")).toBeNull();
    expect(redditUserUrl("AutoModerator")).toBeNull();
    expect(xProfileUrl("@home")).toBeNull();
  });
});

describe("collections", () => {
  test("progress, credits and the key that recognises a repeat", () => {
    expect(progressOutcome("running")).toBe("running");
    expect(progressOutcome("starting")).toBe("running");
    expect(progressOutcome("ready")).toBe("ready");
    expect(progressOutcome("failed")).toBe("failed");
    // A failed input is billed: 0 records + 1 error is 1 credit (the live Instagram check).
    expect(creditsUsed({ records: 0, errors: 1 }, 1)).toBe(1);
    expect(creditsUsed({ records: 2, errors: 0 }, 2)).toBe(2);
    expect(creditsUsed({ records: null, errors: null }, 3)).toBe(3);
    expect(reservedCredits("keyword", [{ keyword: "a" }, { keyword: "b" }], 10)).toBe(20);
    expect(reservedCredits(null, [{ url: "a" }, { url: "b" }], null)).toBe(2);
    const a = collectionKey("reddit_posts", "keyword", [{ keyword: "missed calls", date: "Past month" }], 10);
    expect(collectionKey("reddit_posts", "keyword", [{ keyword: "missed calls", date: "Past month" }], 10)).toBe(a);
    expect(collectionKey("reddit_posts", "keyword", [{ keyword: "missed calls", date: "Past year" }], 10)).not.toBe(a);
  });

  test("errors: a rate limit waits, a used-up account stops, a lost answer is never retried", () => {
    expect(errorKind(429, "Too many requests")).toBe("wait");
    expect(errorKind(402, "")).toBe("exhausted");
    expect(errorKind(403, "Insufficient balance")).toBe("exhausted");
    expect(errorKind(401, "Invalid token")).toBe("rejected");
    expect(errorKind(null, "timeout")).toBe("lost");
    expect(errorKind(502, "Bad gateway")).toBe("lost");
    expect(errorKind(400, "dataset_id is invalid")).toBe("failed");
  });
});
