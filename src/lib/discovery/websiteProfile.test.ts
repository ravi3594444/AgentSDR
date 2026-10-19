import { describe, expect, test } from "bun:test";
import { namedPeople, offerFocus, pageLines, profilePageLinks, readWebsite, recipientFields, websiteNotes, type WebsiteProfile } from "./websiteProfile";

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

  test("with no saved offer to match hiring against, the careers page's slot goes to a contact or about page", () => {
    const html = `<a href="/careers">Careers</a><a href="/contact">Contact</a><a href="/about">About</a><a href="/team">Team</a>`;
    expect(profilePageLinks(html, "https://acme.example/", 3, { careers: false })).toEqual(["https://acme.example/contact", "https://acme.example/about", "https://acme.example/team"]);
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

describe("whose address it is", () => {
  const emailOf = (html: string) => namedPeople(html, "https://reidplumbing.example/team").map((person) => [person.name, person.email]);

  test("an address is a person's own only when it is built from their name, not when it merely contains part of it", () => {
    expect(emailOf(`<h3>Tom Reid</h3><p>Owner</p><p>Write to customerservice@reidplumbing.example</p>`)).toEqual([["Tom Reid", null]]);
    for (const own of ["tom", "tom.reid", "treid", "tomreid", "reid.t", "reid"]) {
      expect(emailOf(`<h3>Tom Reid</h3><p>Owner</p><a href="mailto:${own}@reidplumbing.example">Email</a>`)).toEqual([["Tom Reid", `${own}@reidplumbing.example`]]);
    }
    expect(emailOf(`<h3>Dr. Asha Rao</h3><p>Founder</p><a href="mailto:dr.rao@clinic.example">Email</a>`)).toEqual([["Dr. Asha Rao", "dr.rao@clinic.example"]]);
  });

  test("a colleague's address in the next card is not theirs, even when their names look alike", () => {
    expect(emailOf(`<h3>Tom Reid</h3><p>Owner</p><h3>Tomas</h3><p>Office assistant</p><a href="mailto:tomas@reidplumbing.example">tomas@reidplumbing.example</a>`)).toEqual([["Tom Reid", null]]);
  });
});

describe("only the business's own people, each with their own role and contacts", () => {
  const people = (html: string, url = "https://shahdental.example/our-team") => namedPeople(html, url).map((person) => [person.name, person.role, person.email]);

  test("a card ends where the next person's begins, even one whose role is not a decision-maker's", () => {
    expect(people(`<div><h3>Dr. Anil Shah</h3><p>Founder</p></div><div><h3>Dr. Priya Shah</h3><p>Orthodontist</p><a href="mailto:priya.shah@shahdental.example">priya.shah@shahdental.example</a><a href="https://www.linkedin.com/in/priya-shah">in</a></div>`))
      .toEqual([["Dr. Anil Shah", "Founder", null]]);
    expect(namedPeople(`<div><h3>Dr. Anil Shah</h3><p>Founder</p></div><div><h3>Dr. Priya Shah</h3><p>Orthodontist</p><a href="https://www.linkedin.com/in/priya-shah">in</a></div>`, "https://shahdental.example/team")[0]?.linkedin).toBeNull();
    expect(people(`<div><h3>Ravi Kumar</h3><p>Managing Director</p></div><div><h3>Ravindra Patil</h3><p>Accountant</p><p>ravindra@acme.example</p></div>`)).toEqual([["Ravi Kumar", "Managing Director", null]]);
  });

  test("a LinkedIn profile in a person's card is theirs only when it carries their name", () => {
    const linkedinOf = (slug: string) => namedPeople(`<div><h3>Dr. Anil Shah</h3><p>Founder</p><a href="https://www.linkedin.com/in/${slug}">in</a></div>`, "https://shah.example/team")[0]?.linkedin;
    expect(linkedinOf("priya-mehta-ortho")).toBeNull();
    expect(linkedinOf("anil-shah-dds")).toBe("https://www.linkedin.com/in/anil-shah-dds");
  });

  test("a general inbox named after the business is not the founder's", () => {
    expect(people(`<div><h3>Dr. Anil Shah</h3><p>Founder &amp; Chief Dentist</p><p>Shah Dental Clinic, Baner</p><p>Email: <a href="mailto:shahdentalclinic@gmail.com">shahdentalclinic@gmail.com</a></p></div>`))
      .toEqual([["Dr. Anil Shah", "Founder & Chief Dentist", null]]);
  });

  test("a role above the name, as a label or as a heading, goes to that name", () => {
    const expected = [["Asha Kulkarni", "Founder", null], ["Rohan Deshpande", "Practice Manager", null]];
    expect(people(`<div><span>Founder</span><h3>Asha Kulkarni</h3></div><div><span>Practice Manager</span><h3>Rohan Deshpande</h3></div>`)).toEqual(expected);
    expect(people(`<h2>Our Founder</h2><h3>Asha Kulkarni</h3><h2>Our Practice Manager</h2><h3>Rohan Deshpande</h3>`)).toEqual(expected);
  });

  test("a name and its role in one line's inline elements", () => {
    expect(people(`<div><span class="name">Asha Kulkarni</span> <span class="role">Founder</span></div><h4>Rohan Deshpande <small>Practice Manager</small></h4>`))
      .toEqual([["Asha Kulkarni", "Founder", null], ["Rohan Deshpande", "Practice Manager", null]]);
  });

  test("a testimonial's author and another company's staff are not this business's people", () => {
    const page = `<h2>What our clients say</h2><div><p>Working with them doubled our patient bookings in three months.</p><h5>John Smith</h5><span>CEO, Acme Corp</span></div>
      <div><p>The best agency we have hired.</p><cite>Priya Sharma, Owner of Bloom Florists</cite></div><p>Meera Rao is the founder of Lotus Yoga Studio in Baner.</p>`;
    expect(people(page, "https://agency.example/")).toEqual([]);
    expect(people(`<p>Meera Rao is the founder of Lotus Yoga Studio in Baner.</p>`, "https://lotusyoga.example/about")).toEqual([["Meera Rao", "Founder", null]]);
  });

  test("menus, headings and job titles are not people", () => {
    expect(people(`<nav><ul><li><a href="/board">Board Members</a></li><li><a href="/dm">Director's Message</a></li><li><a href="/mv">Mission Statement</a></li><li><a href="/pm">Principal's Desk</a></li></ul></nav>`, "https://school.example/")).toEqual([]);
    expect(people(`<ul><li>Sales Executive</li><li>Sales Manager</li><li>Senior Developer</li><li>Marketing Manager</li></ul>`, "https://acme.example/team")).toEqual([]);
    expect(people(`<h3>Asha Kulkarni</h3><p>Founder</p>`, "https://acme.example/careers")).toEqual([]);
    expect(people(`<h1>Founded By Local Parents</h1><p>Owned By Taj Hotels</p>`, "https://x.example/about")).toEqual([]);
  });
});

describe("observations the review found too eager", () => {
  const topicsOf = (html: string, url = "https://printco.example/") => readWebsite([{ url, html }], receptionist, AT).observations.map((item) => [item.topic, item.text]);

  test("a supplier inviting its own customers to ask for a quote is not a need; a request for suppliers is", () => {
    expect(topicsOf(`<p>Call us today or send a request for quote about call answering.</p>`).filter(([topic]) => topic === "need")).toEqual([]);
    expect(topicsOf(`<p>We invite proposals for after-hours call answering.</p>`).filter(([topic]) => topic === "need")).toHaveLength(1);
  });

  test("a site asking its visitors, or recruiting resellers, is not asking for suppliers", () => {
    for (const line of [
      "Are you currently looking for a partner to answer your calls? Talk to us.",
      "Are you currently seeking vendors for call answering? We can help.",
      "We are looking for partners: call centres that want to resell our appointment booking app.",
      "Download our free RFP template for call answering services.",
    ]) expect(topicsOf(`<p>${line}</p>`).filter(([topic]) => topic === "need")).toEqual([]);
  });

  test("hiring is a job: not clinic hours or a booking button on a careers page, not 'join our team of patients'", () => {
    expect(topicsOf(`<h1>Careers</h1><p>We're hiring!</p><h4>Clinic Hours</h4><p>Mon–Sat</p><a href="/book">Book an Appointment</a>`, "https://smile.example/careers").filter(([topic]) => topic === "hiring")).toEqual([]);
    expect(topicsOf(`<p>Join our team of patients who never miss an appointment and always get a call back.</p>`).filter(([topic]) => topic === "hiring")).toEqual([]);
  });

  test("a newsletter or login form is not a contact form", () => {
    expect(topicsOf(`<form action="/subscribe"><input type="email" name="email"><button>Subscribe</button></form>`).filter(([topic]) => topic === "contact")).toEqual([]);
  });

  test("a booking vendor's own home page is not the business's booking link", () => {
    expect(topicsOf(`Works with <a href="https://calendly.com/">Calendly</a> and <a href="https://www.zocdoc.com/">Zocdoc</a>`).filter(([topic]) => topic === "booking")).toEqual([]);
    expect(topicsOf(`<a href="https://smile.setmore.com/">Book</a>`).filter(([topic]) => topic === "booking")).toEqual([["booking", "Online booking link (Setmore)"]]);
  });
});

describe("what a site can put into a lead", () => {
  test("a NUL or a lone surrogate in a page never reaches what is stored (jsonb refuses both)", () => {
    const profile = readWebsite([{ url: "https://smile.example/", html: `<meta name="description" content="Family dental clinic&#0; in Pune &#55296;"><h3>Dr. Asha&#0; Kulkarni</h3><p>Founder</p>` }], receptionist, AT);
    const stored = JSON.stringify(websiteNotes(profile, null));
    expect(stored).not.toContain("\\u0000");
    expect(stored).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i);
    expect(profile.observations.find((item) => item.topic === "context")?.text).toContain("Family dental clinic");
  });

  test("a line cut to length never ends in half a character", () => {
    const profile = readWebsite([{ url: "https://smile.example/", html: `<meta name="description" content="${"x".repeat(199)}😀 and more">` }], receptionist, AT);
    expect(JSON.stringify(profile)).not.toMatch(/\\ud83d(?!\\ude)/i);
  });

  test("a role never carries a link or an address", () => {
    expect(namedPeople(`<h3>Tom Reid</h3><p>Owner &amp; www.evil.example/pay</p>`, "https://reid.example/team")).toEqual([]);
  });
});

describe("recipientFields", () => {
  const asha = { name: "Dr. Asha Kulkarni", role: "Founder", email: "asha@smile.example", linkedin: null, sourceUrl: "https://smile.example/team" };

  test("a new person takes the name without the honorific as first and last name, and the role as title", () => {
    expect(recipientFields(asha, null)).toEqual({ fullName: "Dr. Asha Kulkarni", firstName: "Asha", lastName: "Kulkarni", title: "Founder" });
  });

  test("a person the organization already has keeps its own name and title; only empty fields are filled", () => {
    expect(recipientFields(asha, { fullName: "Asha Kulkarni-Rao", firstName: "Asha", lastName: "Kulkarni-Rao", title: "Clinic Director" })).toEqual({});
    expect(recipientFields(asha, { fullName: null, firstName: null, lastName: null, title: "Clinic Director" })).toEqual({ fullName: "Dr. Asha Kulkarni", firstName: "Asha", lastName: "Kulkarni" });
    expect(recipientFields(asha, { fullName: "Asha K", firstName: null, lastName: null, title: null })).toEqual({ title: "Founder" });
  });

  test("no named person: nothing", () => {
    expect(recipientFields(null, null)).toEqual({});
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
