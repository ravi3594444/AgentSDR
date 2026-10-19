import { describe, expect, test } from "bun:test";
import { namedPeople, offerFocus, pageLines, profilePageLinks, readWebsite, websiteNotes, type WebsiteProfile } from "./websiteProfile";

const AT = "2026-10-19T08:00:00.000Z";
const receptionist = offerFocus({
  offer: "An AI receptionist that answers calls and books appointments",
  problemsSolved: "Missed calls after hours",
  targetCustomers: "Dental clinics in Pune",
});
const marketing = offerFocus({ offer: "Social media marketing and Instagram content", targetCustomers: "Dental clinics" });

const home = `<html><head>
  <title>Smile Dental Studio</title>
  <meta name="description" content="Smile Dental Studio is a family dental clinic in Baner, Pune.">
  <script src="https://embed.tawk.to/abc/default"></script>
</head><body>
  <nav><a href="/">Home</a><a href="/services">Services</a><a href="/blog/jobs-to-be-done">Blog</a>
    <a href="/about">About</a><a href="/our-team">Our team</a><a href="/careers">Careers</a><a href="/contact-us">Contact</a></nav>
  <a href="https://calendly.com/smile-dental/checkup">Book an appointment</a>
  <a href="https://wa.me/919822011010?text=Hi">Chat on WhatsApp</a>
  <a href="https://www.facebook.com/smile">Facebook</a>
  <p>Our front desk answers calls from 9 to 6, and appointments after hours go to voicemail.</p>
  <footer>Email: <a href="mailto:hello@smiledental.in">hello@smiledental.in</a></footer>
</body></html>`;

const team = `<html><body>
  <h2>Our Team</h2>
  <div class="card"><h3>Dr. Asha Kulkarni</h3><p>BDS, MDS</p><p>Founder &amp; Lead Dentist</p>
    <a href="mailto:asha@smiledental.in">asha@smiledental.in</a> <a href="https://www.linkedin.com/in/asha-kulkarni-dds/">LinkedIn</a></div>
  <div class="card"><h3>ROHAN DESHPANDE</h3><p>Practice Manager</p><a href="mailto:info@smiledental.in">info@smiledental.in</a>
    <a href="mailto:meera@smiledental.in">Write to Meera</a></div>
  <p>Founded in 2012 by Dr. Meera Joshi, the studio has grown to three chairs.</p>
  <blockquote>“They answered my call on a Sunday!”</blockquote><p>— Priya Sharma, Marketing Manager at Acme Foods</p>
  <p>Book Now</p><p>Contact Us</p>
</body></html>`;

const careers = `<html><body>
  <h1>Careers</h1><p>We're hiring! Join our team.</p>
  <ul><li>Front Desk Receptionist – Full time</li><li>Dental Assistant</li></ul>
</body></html>`;

const contact = `<html><body>
  <form action="/send"><input type="text" name="name"><input type="email" name="email"><textarea name="message"></textarea></form>
  <p>We are seeking a vendor for after-hours call answering for our clinic.</p>
  <p>We give tender care to nervous patients.</p>
</body></html>`;

const pages = [
  { url: "https://smiledental.in/", html: home },
  { url: "https://smiledental.in/our-team", html: team },
  { url: "https://smiledental.in/careers", html: careers },
  { url: "https://smiledental.in/contact-us", html: contact },
];

describe("profilePageLinks", () => {
  test("one page per slot (contact, people, careers) within the same cap of three, same site only", () => {
    expect(profilePageLinks(home, "https://smiledental.in/", 3)).toEqual([
      "https://smiledental.in/contact-us",
      "https://smiledental.in/about",
      "https://smiledental.in/careers",
    ]);
  });

  test("without a careers page the remaining slot is filled the way contact pages always were", () => {
    const html = `<a href="/kontakt">Kontakt</a><a href="/team">Team</a><a href="/impressum">Impressum</a><a href="https://other.example/contact">x</a>`;
    expect(profilePageLinks(html, "https://acme.de/", 3)).toEqual(["https://acme.de/kontakt", "https://acme.de/team", "https://acme.de/impressum"]);
  });

  test("never more than the limit", () => {
    expect(profilePageLinks(home, "https://smiledental.in/", 2)).toHaveLength(2);
  });
});

describe("offerFocus", () => {
  test("offer words and customer words are kept apart, generic words dropped", () => {
    expect(receptionist.offer).toEqual(expect.arrayContaining(["receptionist", "answer", "call", "book", "appointment"]));
    expect(receptionist.customers).toEqual(expect.arrayContaining(["dental", "clinic"]));
    expect(receptionist.offer).not.toContain("dental");
    expect(receptionist.offer).not.toContain("that");
  });

  test("no saved offer: no terms", () => {
    expect(offerFocus({})).toEqual({ offer: [], customers: [] });
  });
});

describe("readWebsite observations", () => {
  const profile = readWebsite(pages, receptionist, AT);
  const topics = (topic: string) => profile.observations.filter((item) => item.topic === topic);

  test("booking and contact options the pages publish, each with its page and uncertainty", () => {
    expect(topics("booking").map((item) => item.text)).toEqual(["Online booking link (Calendly)"]);
    expect(topics("booking")[0]!.sourceUrl).toBe("https://smiledental.in/");
    const contactTexts = topics("contact").map((item) => item.text);
    expect(contactTexts).toContain("WhatsApp chat link (+919822011010)");
    expect(contactTexts).toContain("Live chat on the website (tawk.to)");
    expect(contactTexts).toContain("Contact form");
    for (const item of profile.observations) expect(item.uncertainty.length).toBeGreaterThan(10);
  });

  test("relevant hiring only, from the careers page, marked undated", () => {
    const hiring = topics("hiring");
    expect(hiring.map((item) => item.text)).toEqual(["Front Desk Receptionist – Full time"]);
    expect(hiring[0]!.sourceUrl).toBe("https://smiledental.in/careers");
    expect(hiring[0]!.relevance).toContain("receptionist");
    expect(hiring[0]!.uncertainty).toContain("may already be filled");
  });

  test("an explicit request for a supplier is a need; 'tender care' is not", () => {
    expect(topics("need").map((item) => item.text)).toEqual(["We are seeking a vendor for after-hours call answering for our clinic."]);
  });

  test("their own description, and a sentence that matches the offer", () => {
    const context = topics("context").map((item) => item.text);
    expect(context).toContain("Smile Dental Studio is a family dental clinic in Baner, Pune.");
    expect(context).toContain("Our front desk answers calls from 9 to 6, and appointments after hours go to voicemail.");
  });

  test("the same pages under another organization's offer give other findings", () => {
    const other = readWebsite(pages, marketing, AT);
    expect(other.observations.filter((item) => item.topic === "hiring")).toEqual([]);
    expect(other.observations.filter((item) => item.topic === "need")).toEqual([]);
    expect(other.observations.find((item) => item.text.startsWith("Our front desk"))).toBeUndefined();
    // Published options do not depend on the offer.
    expect(other.observations.filter((item) => item.topic === "booking")).toHaveLength(1);
  });

  test("the time read and the pages read are kept; nothing is ever recorded as absent", () => {
    expect(profile.checkedAt).toBe(AT);
    expect(profile.pagesRead).toEqual(pages.map((page) => page.url));
    for (const item of profile.observations) expect(item.text).not.toMatch(/\b(?:no|not found|does not|doesn't|without)\b/i);
    const bare = readWebsite([{ url: "https://plain.example/", html: "<p>Hello</p>" }], receptionist, AT);
    expect(bare.observations).toEqual([]);
    expect(bare.people).toEqual([]);
  });
});

describe("namedPeople", () => {
  const people = namedPeople(team, "https://smiledental.in/our-team");
  const byName = (name: string) => people.find((person) => person.name === name);

  test("a name with a role in the same card, and only the contacts shown in that card", () => {
    expect(byName("Dr. Asha Kulkarni")).toEqual({ name: "Dr. Asha Kulkarni", role: "Founder & Lead Dentist", email: "asha@smiledental.in", linkedin: "https://www.linkedin.com/in/asha-kulkarni-dds", sourceUrl: "https://smiledental.in/our-team" });
  });

  test("a general address beside a name is not that person's, nor is a colleague's", () => {
    expect(byName("Rohan Deshpande")).toEqual({ name: "Rohan Deshpande", role: "Practice Manager", email: null, linkedin: null, sourceUrl: "https://smiledental.in/our-team" });
  });

  test("'founded by' names the founder", () => {
    expect(byName("Dr. Meera Joshi")?.role).toBe("Founder");
    expect(byName("Dr. Meera Joshi")?.email).toBeNull();
  });

  test("a testimonial's author, headings and buttons are not the business's people", () => {
    expect(people.map((person) => person.name).sort()).toEqual(["Dr. Asha Kulkarni", "Dr. Meera Joshi", "Rohan Deshpande"]);
  });

  test("one line: 'Name, Role' and 'Role: Name'; a role at another company is not theirs", () => {
    expect(namedPeople("<p>Vikram Patil, Managing Director</p><p>Owner: Neha Gokhale</p><p>Sanjay Bhide, Head of Sales at Other Corp</p>", "https://x.example/about").map((person) => [person.name, person.role]))
      .toEqual([["Vikram Patil", "Managing Director"], ["Neha Gokhale", "Owner"]]);
  });
});

describe("websiteNotes", () => {
  const profile: WebsiteProfile = readWebsite(pages, receptionist, AT);

  test("a general address: the lead is the business, and its people are facts for the writer", () => {
    const notes = websiteNotes(profile, "hello@smiledental.in");
    expect(notes.recipient).toBeNull();
    expect(notes.facts.decisionMakers).toBe("Dr. Asha Kulkarni (Founder & Lead Dentist); Rohan Deshpande (Practice Manager)");
    expect(notes.facts.hiring).toBe("Front Desk Receptionist – Full time");
    expect(notes.facts.booking).toBe("Online booking link (Calendly)");
    expect(notes.facts.websiteNeed).toBe("We are seeking a vendor for after-hours call answering for our clinic.");
  });

  test("a person's own address: the lead is that person, and they are not listed as someone else", () => {
    const notes = websiteNotes(profile, "asha@smiledental.in");
    expect(notes.recipient?.name).toBe("Dr. Asha Kulkarni");
    expect(notes.facts.decisionMakers).toBe("Rohan Deshpande (Practice Manager); Dr. Meera Joshi (Founder)");
  });

  test("signals: website findings are observations with their page, read time and uncertainty; only the request is a need", () => {
    const notes = websiteNotes(profile, null);
    for (const signal of notes.signals) {
      expect(signal.at).toBeNull();
      expect(signal.observedAt).toBe(AT);
      expect(signal.uncertainty?.length).toBeGreaterThan(10);
      expect(signal.source).toBe("the business's website");
      expect(signal.kind).toBe(signal.topic === "need" ? "need" : "observation");
    }
    const person = notes.signals.find((signal) => signal.topic === "person" && signal.person?.name === "Dr. Asha Kulkarni");
    expect(person?.person).toEqual({ name: "Dr. Asha Kulkarni", role: "Founder & Lead Dentist", email: "asha@smiledental.in", linkedin: "https://www.linkedin.com/in/asha-kulkarni-dds" });
    expect(person?.uncertainty).toContain("beside their name");
  });

  test("no website read: nothing at all", () => {
    expect(websiteNotes(null, "info@acme.com")).toEqual({ signals: [], facts: {}, recipient: null });
  });

  test("facts never state that something is missing", () => {
    const bare = websiteNotes(readWebsite([{ url: "https://plain.example/", html: "<p>Hello</p>" }], receptionist, AT), null);
    expect(bare.facts).toEqual({});
  });
});

describe("hostile pages", () => {
  const SIZE = 1_500_000;
  const hostile: Record<string, string> = {
    "one long word": "a".repeat(SIZE),
    "unclosed tags": "<a b".repeat(SIZE / 4),
    "many short paragraphs": "<p>Asha Kulkarni</p><p>Founder</p>".repeat(SIZE / 34),
    "a long line of capitalised words": `<p>${"Word ".repeat(SIZE / 5)}</p>`,
    "unclosed forms": "<form>".repeat(SIZE / 6),
    "many anchors": "<a href=/careers>x</a>".repeat(SIZE / 22),
    "a long meta tag": `<meta content="${"x".repeat(SIZE)}`,
  };
  for (const [label, html] of Object.entries(hostile)) {
    test(`${label} (1.5 MB) is read in well under a second`, () => {
      const started = performance.now();
      readWebsite([{ url: "https://hostile.example/careers", html }], receptionist, AT);
      profilePageLinks(html, "https://hostile.example/");
      pageLines(html);
      expect(performance.now() - started).toBeLessThan(500);
    });
  }
});
