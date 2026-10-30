import { describe, expect, test } from "bun:test";
import type { ResearchElement, ResearchSnapshot } from "@/lib/browser/connected/contract";
import { accountOnPage, courierStepVerdict, messageOnPage, newReplies, onSite, profileVerdict, type CourierState, type CourierStep } from "./courier";
import { looksLikePhoneRecipient, profileRoute, recipientPhone, recipientRef } from "./routes";

const element = (patch: Partial<ResearchElement>): ResearchElement => ({ n: 1, kind: "button", label: "", href: null, write: true, search: false, ...patch });
const page = (elements: ResearchElement[], text = "Home Explore Notifications Messages @owner_handle Priya Sharma @priya_k"): ResearchSnapshot => ({
  url: "https://x.com/priya_k", title: "Priya Sharma (@priya_k) / X", text, scroll: { y: 0, height: 900, viewport: 900 }, attention: null, readAt: new Date(0).toISOString(), elements,
});
const MESSAGE = "Hi Priya, saw your post about onboarding. Want a 10-minute look at how we cut setup time?";
const step = (patch: Partial<CourierStep>): CourierStep => ({ account: null, note: "", do: "click", n: null, text: null, key: null, direction: null, url: null, outcome: null, reason: null, ...patch });
const state = (snapshot: ResearchSnapshot, patch: Partial<CourierState> = {}): CourierState => ({ message: MESSAGE, site: "x", recipient: { handle: "priya_k", name: "Priya Sharma" }, snapshot, account: "@owner_handle", sent: false, ...patch });

describe("profiles a browser can message", () => {
  test("direct phone recipients retain the exact international destination, without silently repairing a number", () => {
    expect(recipientRef("+1 (202) 555-0101").phone).toBe("+12025550101");
    expect(recipientPhone("0012025550101")).toBe("+12025550101");
    expect(recipientPhone("+1 202555010199")).toBeNull();
    expect(recipientPhone("+0012025550101")).toBeNull();
    expect(recipientPhone("2025550101")).toBeNull();
    expect(looksLikePhoneRecipient("+1 202555010199")).toBe(true);
    expect(looksLikePhoneRecipient("Priya Sharma")).toBe(false);
    expect(recipientRef("priya@acme.net").phone).toBeUndefined();
  });
  test("a person's own profile on each site; never a post, a search or a site page", () => {
    expect(profileRoute("https://x.com/Priya_K")).toEqual({ site: "x", handle: "priya_k", profileUrl: "https://x.com/Priya_K" });
    expect(profileRoute("twitter.com/priya_k")?.site).toBe("x");
    expect(profileRoute("https://www.instagram.com/priya.k/")).toMatchObject({ site: "instagram", handle: "priya.k" });
    expect(profileRoute("https://www.facebook.com/profile.php?id=100012345678")).toMatchObject({ site: "facebook", handle: "100012345678" });
    expect(profileRoute("https://www.linkedin.com/in/priya-sharma-1a2b/")).toMatchObject({ site: "linkedin", handle: "priya-sharma-1a2b" });
    for (const other of ["https://x.com/priya_k/status/1", "https://x.com/search?q=founders", "https://x.com/home", "https://www.instagram.com/p/Cabc/", "https://www.facebook.com/groups/123", "https://www.linkedin.com/company/acme", "https://example.com/priya"]) {
      expect(profileRoute(other)).toBeNull();
    }
  });

  test("a recipient as the model names it: an address, a profile, or @handle on a site", () => {
    expect(recipientRef("Jane@Acme.co")).toMatchObject({ email: "jane@acme.co", route: null });
    expect(recipientRef("@priya_k on X").route).toMatchObject({ site: "x", handle: "priya_k" });
    expect(recipientRef("priya.k on Instagram").route).toMatchObject({ site: "instagram", handle: "priya.k" });
    expect(recipientRef("Priya Sharma").route).toBeNull();
  });

  test("what a profile page shows about messaging them", () => {
    expect(profileVerdict(page([element({ label: "Message" })])).state).toBe("messageable");
    expect(profileVerdict(page([element({ label: "Follow" })], "This account doesn’t exist. Try searching for another.")).state).toBe("not_found");
    expect(profileVerdict(page([], "Sorry, this page isn't available.")).state).toBe("not_found");
    expect(profileVerdict(page([element({ label: "Follow" })], "Priya can't be messaged")).state).toBe("not_messageable");
    expect(profileVerdict(page([element({ label: "Follow" })])).state).toBe("unverified");
  });
});

describe("what the courier may do on the page", () => {
  test("it opens a message to the person, but never invites, follows, posts or pays", () => {
    const profile = page([element({ n: 1, label: "Message" }), element({ n: 2, label: "Follow" }), element({ n: 3, label: "Invite" }), element({ n: 4, label: "Buy now" }), element({ n: 5, kind: "link", label: "Posts", write: false })]);
    expect(courierStepVerdict(step({ n: 1 }), state(profile))).toEqual({ problem: null, sends: false, opensComposer: true });
    expect(courierStepVerdict(step({ n: 2 }), state(profile)).problem).toContain("publish");
    expect(courierStepVerdict(step({ n: 3 }), state(profile)).problem).toContain("not a way to open a message");
    expect(courierStepVerdict(step({ n: 4 }), state(profile)).problem).toContain("pay");
    expect(courierStepVerdict(step({ n: 5 }), state(profile))).toEqual({ problem: null, sends: false, opensComposer: false });
  });

  test("it types only the approved text (or the recipient in a search box), never into a password field", () => {
    const composer = page([element({ n: 7, kind: "input", label: "Start a new message", write: false, field: { type: "editor", value: "" } }), element({ n: 8, kind: "input", label: "Search people", write: false, search: true, field: { type: "search", value: "" } }), element({ n: 9, kind: "input", label: "Password", write: false, field: { type: "password", value: "", sensitive: true } })]);
    expect(courierStepVerdict(step({ do: "fill", n: 7, text: MESSAGE }), state(composer)).problem).toBeNull();
    expect(courierStepVerdict(step({ do: "fill", n: 7, text: `${MESSAGE} Also, are you hiring?` }), state(composer)).problem).toContain("approved message");
    expect(courierStepVerdict(step({ do: "fill", n: 8, text: "@priya_k" }), state(composer)).problem).toBeNull();
    expect(courierStepVerdict(step({ do: "fill", n: 7, text: "@priya_k" }), state(composer)).problem).toContain("approved message");
    expect(courierStepVerdict(step({ do: "fill", n: 9, text: "hunter2" }), state(composer)).problem).toContain("password");
  });

  test("it sends once, only with the approved text in the box and the account confirmed", () => {
    const empty = page([element({ n: 7, kind: "input", label: "Message", write: false, field: { type: "editor", value: "" } }), element({ n: 8, label: "Send" })]);
    const other = page([element({ n: 7, kind: "input", label: "Message", write: false, field: { type: "editor", value: "Something else" } }), element({ n: 8, label: "Send" })]);
    const ready = page([element({ n: 7, kind: "input", label: "Message", write: false, field: { type: "editor", value: MESSAGE } }), element({ n: 8, label: "Send" }), element({ n: 9, label: "" })]);
    expect(courierStepVerdict(step({ n: 8 }), state(empty)).problem).toContain("empty");
    expect(courierStepVerdict(step({ n: 8 }), state(other)).problem).toContain("other text");
    expect(courierStepVerdict(step({ n: 8 }), state(ready, { account: null })).problem).toContain("account");
    expect(courierStepVerdict(step({ n: 8 }), state(ready))).toEqual({ problem: null, sends: true, opensComposer: false });
    // An icon button with no words beside the approved text is the send too.
    expect(courierStepVerdict(step({ n: 9 }), state(ready))).toEqual({ problem: null, sends: true, opensComposer: false });
    expect(courierStepVerdict(step({ do: "press", n: 7, key: "Enter" }), state(ready))).toEqual({ problem: null, sends: true, opensComposer: false });
    expect(courierStepVerdict(step({ n: 8 }), state(ready, { sent: true })).problem).toContain("already sent");
    expect(courierStepVerdict(step({ do: "finish", outcome: "sent" }), state(ready)).problem).toContain("nothing was sent");
  });

  test("it opens pages only on the route's own site", () => {
    expect(onSite("https://x.com/messages/compose", "x")).toBe(true);
    expect(onSite("https://mobile.twitter.com/priya_k", "x")).toBe(true);
    expect(onSite("https://x.com.evil.io/", "x")).toBe(false);
    expect(onSite("http://x.com/priya_k", "x")).toBe(false);
    expect(onSite("https://www.messenger.com/t/123", "facebook")).toBe(true);
    expect(courierStepVerdict(step({ do: "open", url: "https://evil.example/" }), state(page([]))).problem).toContain("only pages on X");
  });
});

describe("what counts as sent, and as a reply", () => {
  test("sent is the page showing the text; the account is the page showing it", () => {
    expect(messageOnPage(`Priya Sharma @priya_k ${MESSAGE} Sent`, MESSAGE)).toBe(true);
    expect(messageOnPage("Priya Sharma @priya_k Start a new message", MESSAGE)).toBe(false);
    expect(accountOnPage("Home Messages @Owner_Handle Profile", "@owner_handle")).toBe(true);
    expect(accountOnPage("Home Messages Profile", "@owner_handle")).toBe(false);
  });

  test("a reply must be on the page, not the owner's own, and new", () => {
    const pageText = `${MESSAGE} Thanks! Tuesday works. Thanks!`;
    const known = [{ direction: "outbound" as const, text: MESSAGE }];
    expect(newReplies(pageText, ["Thanks! Tuesday works.", "Can you call me?", MESSAGE], known)).toEqual(["Thanks! Tuesday works."]);
    // Known already: only a repeat the page shows more times than the CRM holds is new.
    expect(newReplies(pageText, ["Thanks!"], [...known, { direction: "inbound", text: "Thanks!" }])).toEqual(["Thanks!"]);
    expect(newReplies(pageText, ["Thanks! Tuesday works."], [...known, { direction: "inbound", text: "Thanks! Tuesday works." }])).toEqual([]);
    // The owner's message as sent carries a signature: part of it is still the owner's, not a reply.
    const signed = [{ direction: "outbound" as const, text: `${MESSAGE}\n\n– Ravi, OnboardKit` }];
    expect(newReplies(`${MESSAGE} – Ravi, OnboardKit`, [MESSAGE, "Ravi, OnboardKit"], signed)).toEqual([]);
  });
});
