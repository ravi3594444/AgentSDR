import { describe, expect, test } from "bun:test";
import {
  buildSearchQueries,
  classifySourceUrl,
  directoryBusinessLinks,
  directoryListingContacts,
  instagramTarget,
  matchReasonFor,
  MAX_SEARCH_QUERIES,
  needSignal,
  ownerMailDomain,
} from "./webDiscovery";

describe("buildSearchQueries", () => {
  test("asks for the businesses' own websites and for local directories, in the area", () => {
    const queries = buildSearchQueries({ customers: "dental clinics", where: "Baner, Pune", offer: "dental equipment servicing", language: "en" });
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("dental clinics in Baner, Pune");
    expect(queries[0]).toContain("own websites");
    // The offer keeps competitors out instead of steering towards them.
    expect(queries[0]).toContain("not suppliers of dental equipment servicing");
    expect(queries[1]).toContain("directories");
    expect(queries[1]).toContain("dental clinics in Baner, Pune");
    expect(queries.some((query) => /instagram/i.test(query))).toBe(false);
  });

  test("adds public Instagram profiles and posts only when Instagram can be read, never more than three", () => {
    const queries = buildSearchQueries({ customers: "home bakers", where: "Pune", instagram: true });
    expect(queries).toHaveLength(3);
    expect(queries.length).toBeLessThanOrEqual(MAX_SEARCH_QUERIES);
    expect(queries[2]).toContain("Public Instagram profiles and posts of home bakers in Pune");
  });

  test("another language allows its pages too; no offer means no offer clause", () => {
    const [first] = buildSearchQueries({ customers: "Zahnarztpraxen", where: "München", language: "de" });
    expect(first).toContain("Pages in German or English.");
    expect(first).not.toContain("suppliers");
  });
});

describe("classifySourceUrl", () => {
  test("a business's own site", () => {
    expect(classifySourceUrl("https://www.lotusdental.in/")).toBe("own_site");
    expect(classifySourceUrl("https://smile-care.co.in/services/implants")).toBe("own_site");
    expect(classifySourceUrl("https://acme.wixsite.com/clinic")).toBe("own_site");
  });

  test("directories and list pages", () => {
    expect(classifySourceUrl("https://www.justdial.com/Pune/Dentists-in-Baner/nct-10156331")).toBe("directory");
    expect(classifySourceUrl("https://www.yelp.co.uk/search?find_desc=dentist")).toBe("directory");
    expect(classifySourceUrl("https://www.practo.com/pune/dentist/baner")).toBe("directory");
    expect(classifySourceUrl("https://citymagazine.example.in/top-10-dentists-in-pune/")).toBe("directory");
    expect(classifySourceUrl("https://dentalassociation.example.org/member-directory")).toBe("directory");
  });

  test("Instagram profiles and posts, and Instagram pages that are neither", () => {
    expect(classifySourceUrl("https://www.instagram.com/lotus.dental/")).toBe("instagram_profile");
    expect(classifySourceUrl("https://instagram.com/lotus.dental?igsh=abc")).toBe("instagram_profile");
    expect(classifySourceUrl("https://www.instagram.com/p/C9xYz12AbCd/")).toBe("instagram_post");
    expect(classifySourceUrl("https://www.instagram.com/reel/C9xYz12AbCd/?utm_source=ig_web")).toBe("instagram_post");
    expect(classifySourceUrl("https://www.instagram.com/lotus.dental/p/C9xYz12AbCd/")).toBe("instagram_post");
    expect(classifySourceUrl("https://www.instagram.com/explore/tags/dentist/")).toBe("unusable");
    expect(classifySourceUrl("https://www.instagram.com/stories/lotus.dental/123/")).toBe("unusable");
  });

  test("other social networks, and pages that are no business at all", () => {
    expect(classifySourceUrl("https://www.facebook.com/lotusdental")).toBe("social_other");
    expect(classifySourceUrl("https://www.linkedin.com/company/lotus")).toBe("social_other");
    expect(classifySourceUrl("https://linktr.ee/lotus")).toBe("social_other");
    expect(classifySourceUrl("https://www.google.com/maps/place/Lotus")).toBe("unusable");
    expect(classifySourceUrl("https://en.wikipedia.org/wiki/Pune")).toBe("unusable");
    expect(classifySourceUrl("https://www.wix.com/")).toBe("unusable");
    expect(classifySourceUrl("https://lotus.example.in/brochure.pdf")).toBe("unusable");
    expect(classifySourceUrl("ftp://lotus.example.in/")).toBe("unusable");
    expect(classifySourceUrl("not a url")).toBe("unusable");
    expect(classifySourceUrl("http://127.0.0.1:8080/")).toBe("unusable");
  });
});

describe("instagramTarget", () => {
  test("canonical profile and post URLs", () => {
    expect(instagramTarget("https://m.instagram.com/Lotus.Dental/?hl=en")).toEqual({ kind: "instagram_profile", username: "lotus.dental", url: "https://www.instagram.com/lotus.dental/" });
    expect(instagramTarget("https://www.instagram.com/reel/C9xYz12AbCd/?igsh=1")).toEqual({ kind: "instagram_post", shortcode: "C9xYz12AbCd", url: "https://www.instagram.com/reel/C9xYz12AbCd/" });
    expect(instagramTarget("https://www.facebook.com/x")).toBeNull();
  });
});

describe("directoryBusinessLinks", () => {
  const page = "https://citymagazine.example.in/top-10-dentists-in-pune/";
  const html = `
    <nav><a href="/about">About us</a><a href="https://citymagazine.example.in/contact">Contact</a></nav>
    <ol>
      <li><h3>Lotus Dental Care</h3><a href="https://www.lotusdental.example.in/?utm=x#top">Lotus Dental Care</a></li>
      <li><a href='https://smilecare.example.com/contact'>Visit website</a></li>
      <li><a href="https://www.facebook.com/brightsmile">Bright Smile on Facebook</a></li>
      <li><a href="https://www.justdial.com/Pune/Bright-Smile">Bright Smile on Justdial</a></li>
      <li><a href="https://www.instagram.com/brightsmile/">Instagram</a></li>
      <li><a href="https://lotusdental.example.in/team">Lotus team</a></li>
      <li><a href="mailto:editor@citymagazine.example.in">Write to us</a></li>
      <li><a href=https://pearl-dental.example.org>Pearl &amp; Co Dental</a></li>
    </ol>
    <a href="https://www.google.com/maps/place/x">Map</a>`;

  test("keeps the listed businesses' own sites, one per site, with names where the link gives one", () => {
    expect(directoryBusinessLinks(html, page, 20)).toEqual([
      { url: "https://www.lotusdental.example.in/?utm=x", text: "Lotus Dental Care" },
      { url: "https://smilecare.example.com/contact", text: null },
      { url: "https://pearl-dental.example.org/", text: "Pearl & Co Dental" },
    ]);
  });

  test("stops at the limit", () => {
    expect(directoryBusinessLinks(html, page, 1)).toHaveLength(1);
  });
});

describe("directoryListingContacts", () => {
  const page = "https://www.citydirectory.example.in/pune/dentists";
  const html = `
    <header><a href="tel:+91 20 4000 0000">Helpline</a><a href="mailto:care@help-desk.example.com">Help</a></header>
    <nav><a href="tel:1800-123-4567">Toll free</a></nav>
    <ul>
      <li>Lotus Dental <a href="tel:+912025531234">Call</a> <a href="tel:+912025531234">+91 20 2553 1234</a> · book via <a href="tel:+912040001111">our helpline</a></li>
      <li>Smile Care <a href="mailto:hello@smilecare.example.in">hello@smilecare.example.in</a> · book via <a href="tel:+912040001111">our helpline</a></li>
      <li>Pearl Dental <a href="tel:+912025550003">Call</a> · book via <a href="tel:+912040001111">our helpline</a></li>
      <li>Listed by <a href="mailto:listings@citydirectory.example.in">our team</a></li>
    </ul>
    <footer>Customer care <a href="tel:+912040002222">020 4000 2222</a> <a href="mailto:support@gmail.com">support@gmail.com</a></footer>`;

  test("keeps each listing's own contacts, even when one listing shows its number twice", () => {
    expect(directoryListingContacts(html, page).map((contact) => contact.value)).toEqual(["+912025531234", "hello@smilecare.example.in", "+912025550003"]);
  });

  test("drops the directory's header, navigation and footer, a helpline beside every listing, and its own domain", () => {
    const values = directoryListingContacts(html, page).map((contact) => contact.value);
    for (const own of ["+912040000000", "18001234567", "+912040001111", "+912040002222", "support@gmail.com", "care@help-desk.example.com", "listings@citydirectory.example.in"]) {
      expect(values).not.toContain(own);
    }
  });
});

describe("ownerMailDomain", () => {
  test("a business mailbox's domain is the owner's; a free mail provider's is not", () => {
    expect(ownerMailDomain("ravi@lotusdental.example.in")).toBe("lotusdental.example.in");
    expect(ownerMailDomain("ravi.lotus@gmail.com")).toBeNull();
    expect(ownerMailDomain("ravi@yahoo.co.in")).toBeNull();
    expect(ownerMailDomain("ravi@rediffmail.com")).toBeNull();
  });
});

describe("matchReasonFor", () => {
  const source = { query: "dental clinics in Baner, Pune", url: "https://lotus.example.in/", title: "Lotus Dental Care | Baner", snippet: "Family dental clinic in Baner, Pune since 2004." };

  test("quotes the provider's title and snippet and the query", () => {
    expect(matchReasonFor(source)).toBe("The web search for “dental clinics in Baner, Pune” returned https://lotus.example.in/: “Lotus Dental Care | Baner” — “Family dental clinic in Baner, Pune since 2004.”.");
  });

  test("says so when the provider gave no title or snippet, and invents none", () => {
    expect(matchReasonFor({ ...source, title: null, snippet: null })).toBe("The web search for “dental clinics in Baner, Pune” returned https://lotus.example.in/ (with no title or description).");
  });

  test("a lead reached through a directory, a profile or a comment names the page the search returned", () => {
    const directory = { ...source, url: "https://city.example.in/top-10-dentists/", title: "Top 10 dentists in Pune", snippet: null };
    expect(matchReasonFor({ ...directory, via: "linked_from" })).toBe("Linked from “Top 10 dentists in Pune” (https://city.example.in/top-10-dentists/), a page the web search for “dental clinics in Baner, Pune” returned.");
    expect(matchReasonFor({ ...directory, via: "listed_on" })).toContain("Listed on “Top 10 dentists in Pune”");
    expect(matchReasonFor({ ...source, url: "https://www.instagram.com/p/C9xYz12AbCd/", via: "commented_on" })).toBe("Commented on the Instagram post https://www.instagram.com/p/C9xYz12AbCd/, which the web search for “dental clinics in Baner, Pune” returned.");
  });

  test("a redirected page: the search returned the provider's URL; the page read is named apart, never as a search result", () => {
    const directory = { ...source, url: "https://city.example.in/best-dentists/", finalUrl: "https://city.example.in/list-of-dentists-2026/", title: "Best dentists", snippet: null };
    const reason = matchReasonFor({ ...directory, via: "listed_on" });
    expect(reason).toBe("Listed on “Best dentists” (https://city.example.in/best-dentists/), a page the web search for “dental clinics in Baner, Pune” returned, which redirected to https://city.example.in/list-of-dentists-2026/, where it was read.");
    expect(reason).not.toContain("list-of-dentists-2026/), a page the web search");
  });
});

describe("needSignal", () => {
  test("explicit asks are needs", () => {
    for (const text of [
      "need a dentist near Baner, any recommendation?",
      "Looking for a good orthodontist in Aundh",
      "Can anyone recommend a clinic for root canal?",
      "anyone know a good physio near Wakad",
      "Where can I get braces done in Pune?",
      "How much for teeth whitening?",
      "Price?",
      "price pls",
      "What are your charges for a cleaning",
      "Can I get a quote for 3 implants",
      "do you deliver to Kothrud?",
      "mujhe bhi chahiye",
      "ye kahan milega?",
      "kitne ka hai?",
      "koi suggest karo achha dentist",
      "rate kya hai bhai",
      "@rahul need a dentist near Baner, any recommendation?",
      "looking for a physio near Baner",
      "how much for a cleaning?",
      "and how much is it?",
      "How much does a root canal cost",
      "anyone know a good dentist in Pune?",
      "Do you know a good dentist near Aundh?",
      "Does anyone know how to book an appointment?",
      "Do you know how to reach them?",
    ]) expect([text, needSignal(text)]).toEqual([text, "need"]);
  });

  test("likes, follows, emojis, praise and tags are engagement, never needs", () => {
    for (const text of [
      "😍🔥",
      "follow back",
      "nice post",
      "Nice!! 👏👏",
      "Highly recommended, best clinic in Pune",
      "I'd recommend a visit here to everyone",
      "I need this 😂",
      "@priya_k @rohit.s look at this",
      "@priya_k we need a trip here",
      "No need to look further, best doctor!",
      "You don't know how much I love this place",
      "kitna sundar hai",
      "I love how much this place has grown!",
      "Can't believe how much it changed",
      "Do you know how beautiful this is?",
      "Do you know how much I love this place?",
      "Mujhe nahi chahiye",
      "mujhe ye nahin chahiye bhai",
      "mat chahiye",
      "need nahi hai",
      "Thank you so much doctor",
      "",
      "🙏",
    ]) expect([text, needSignal(text)]).toEqual([text, "engagement"]);
  });
});
