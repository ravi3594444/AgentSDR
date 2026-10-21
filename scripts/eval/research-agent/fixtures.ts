/**
 * The research agent's evaluation cases: owner requests, what every stand-in
 * provider returns for them, the ground truth for each lead, and what a good
 * outcome looks like (`expect`, graded by score.ts on what lands in the
 * database, never on wording). Weak results are deliberate: irrelevant
 * accounts, accounts whose place is shown only somewhere a city-word check
 * does not read, duplicates, a wrong city.
 *
 * Hosts: business websites are <slug>-audit.netlify.app (they resolve in
 * public DNS, so read_webpage's public-address check passes, but every HTTP
 * request is answered by the harness; nothing reaches them). Directories use
 * www.yelp.com / www.ycombinator.com paths, also answered by the harness.
 *
 * Cases c1–c5 come from the 21 Oct 2026 research-agent audit; c5b, c6, c7
 * and c8 cover the wordings and situations it found mishandled.
 */

export type GroundTruth =
  | "match" // fits the request, with the evidence in a field the code reads
  | "match_website" // fits; the place is stated only on its own website
  | "match_provider_field" // fits; the place is only in a provider field AgentSDR does not store (latestPosts.locationName)
  | "match_neighbourhood" // fits; the profile names a neighbourhood of the city, not the city
  | "unverified" // may fit; only weak evidence (a handle)
  | "unknown" // nothing anywhere places it
  | "no_match_city"
  | "no_match_kind"
  | "no_match_role";

export type Truth = { key: RegExp; label: GroundTruth; why: string };

export const site = (slug: string) => `https://${slug}-audit.netlify.app/`;
const mail = (local: string, slug: string) => `${local}@${slug}-audit.netlify.app`;

export type MapsRow = { title: string; category: string; address: string; city: string; website?: string; phone?: string; rating?: number };
export type IgProfile = { fullName: string; biography: string; externalUrl?: string; businessEmail?: string; businessCategoryName?: string; latestPosts?: { locationName?: string; caption?: string }[] };
export type IgPost = { ownerUsername: string; caption: string; locationName?: string; shortcode: string };
export type SearchHit = { title: string; url: string; snippet: string };
export type LinkedinLead = { profileUrl: string; name: string; headline: string; companyName: string | null; location: string | null };

export type CaseFixture = {
  id: string;
  title: string;
  prompt: string;
  /** What the owner answers when the assistant's first turn ends with a question and starts no search. */
  followUp: string | null;
  profile: Record<string, string>;
  senders: { instagram?: boolean; email?: boolean; linkedin?: boolean };
  /** Google Maps scraper rows for the nth scraper job of the run (0-based) and its phrase. */
  maps: (phrase: string, nth: number) => MapsRow[];
  igProfiles: Record<string, IgProfile>;
  igHashtagPosts: IgPost[];
  igSearch: string[];
  facebookPages: Record<string, unknown>[];
  linkedinCompanies: Record<string, unknown>[];
  linkedinPeople: LinkedinLead[];
  tinyfish: (query: string) => SearchHit[];
  sites: Record<string, string>;
  truth: Truth[];
  expect: Expectation;
};

/** What a good outcome is for a case (score.ts). */
export type Expectation = {
  /** The owner asked to contact the leads; false: research only, no plan may be prepared. */
  contact: boolean;
  /** The only channels a plan may assign (the owner's words); null: any ready channel. */
  channels: readonly string[] | null;
  /** The lead target the owner named, if any: no plan contacts more. */
  target: number | null;
  /** Free sources only: no paid provider call and nothing spent. */
  noPaid?: boolean;
  /** At most this many searches (a bounded test). */
  maxSearches?: number;
  /** At least this many distinct true matches judged as matching (recall). */
  minMatches: number;
  /** A plan is possible (a ready sender and reachable true matches); when false, none should be prepared. */
  planPossible: boolean;
  /** The request ends as done, not as short of a target (a bounded test). */
  endsDone?: boolean;
};

const page = (title: string, body: string, links: string[] = []) =>
  `<html><head><title>${title}</title><meta name="description" content="${title}"></head><body><h1>${title}</h1>${body}${links.map((link) => `<a href="${link}">${link}</a>`).join(" ")}</body></html>`;

// ── Case 1: city-specific Instagram prospects ────────────────────────────────

const c1Sites: Record<string, string> = {
  [site("glowhair")]: page("Glow Hair Studio — Miami hair salon", `<p>Hair salon in Midtown, Miami, FL. Balayage, color and cuts.</p><p><a href="mailto:${mail("hello", "glowhair")}">${mail("hello", "glowhair")}</a> <a href="tel:+13055550101">(305) 555-0101</a></p>`, ["https://www.instagram.com/glowmiami.salon/"]),
  [site("studiolumiere")]: page("Studio Lumière Hair Salon", `<p>Studio Lumière, hair salon at 2450 Coral Way, Miami, FL 33145.</p><p>Call <a href="tel:+13055550142">(305) 555-0142</a> or write <a href="mailto:${mail("hola", "studiolumiere")}">${mail("hola", "studiolumiere")}</a>.</p>`),
  [site("salonbella")]: page("Salon Bella Miami", `<p>Hair salon on Biscayne Blvd, Miami, FL since 2011.</p><p><a href="mailto:${mail("book", "salonbella")}">${mail("book", "salonbella")}</a></p>`, ["https://www.instagram.com/salonbella.miami/"]),
  [site("wynwoodhair")]: page("Wynwood Hair Lounge", `<p>Hair salon in Wynwood, Miami. Cuts, color, keratin.</p><p><a href="mailto:${mail("hi", "wynwoodhair")}">${mail("hi", "wynwoodhair")}</a></p>`),
  [site("melrosehair")]: page("Melrose Hair Co — Los Angeles", `<p>Hair salon on Melrose Ave, Los Angeles, CA.</p><p><a href="mailto:${mail("book", "melrosehair")}">${mail("book", "melrosehair")}</a></p>`),
  [site("fortlauderdalehair")]: page("Las Olas Hair Studio — Fort Lauderdale", `<p>Hair salon on Las Olas Blvd, Fort Lauderdale, FL.</p><p><a href="mailto:${mail("info", "fortlauderdalehair")}">${mail("info", "fortlauderdalehair")}</a></p>`),
  [site("sallybeauty")]: page("Sally Beauty Supply — Miami", `<p>Beauty supply store: hair color, tools and products.</p><p><a href="mailto:${mail("store", "sallybeauty")}">${mail("store", "sallybeauty")}</a></p>`),
  ["https://www.yelp.com/search?find_desc=Hair+Salons&find_loc=Miami%2C+FL"]: page("Top 10 Best Hair Salons in Miami, FL", `<ol><li><a href="${site("wynwoodhair")}">Wynwood Hair Lounge</a></li><li><a href="${site("salonbella")}">Salon Bella Miami</a></li><li><a href="${site("glowhair")}">Glow Hair Studio</a></li></ol>`),
};

const C1: CaseFixture = {
  id: "c1",
  title: "City-specific Instagram prospects",
  prompt: "Find 10 hair salons in Miami on Instagram and DM them",
  followUp: "Miami, Florida. Just hair salons, and DM them on Instagram.",
  profile: { businessName: "SalonFlow", offer: "Online booking and automatic appointment reminders for hair salons", targetCustomers: "hair salons", locations: "Florida", senderName: "Ravi" },
  senders: { instagram: true },
  expect: { contact: true, channels: ["instagram"], target: 10, minMatches: 4, planPossible: true },
  maps: () => [
    { title: "Salon Bella Miami", category: "Hair salon", address: "1200 Biscayne Blvd, Miami, FL 33132", city: "Miami", website: site("salonbella"), phone: "+1 305-555-0110", rating: 4.7 },
    { title: "Supercuts Brickell", category: "Hair salon", address: "901 S Miami Ave, Miami, FL 33130", city: "Miami", phone: "+1 305-555-0111", rating: 4.1 },
    { title: "Sally Beauty Supply", category: "Beauty supply store", address: "3401 N Miami Ave, Miami, FL 33127", city: "Miami", website: site("sallybeauty"), phone: "+1 305-555-0112", rating: 4.3 },
    { title: "Wynwood Hair Lounge", category: "Hair salon", address: "250 NW 23rd St, Miami, FL 33127", city: "Miami", website: site("wynwoodhair"), rating: 4.8 },
    { title: "Las Olas Hair Studio", category: "Hair salon", address: "800 E Las Olas Blvd, Fort Lauderdale, FL 33301", city: "Fort Lauderdale", website: site("fortlauderdalehair"), rating: 4.6 },
    { title: "Glow Hair Studio", category: "Hair salon", address: "3401 N Miami Ave, Miami, FL 33127", city: "Miami", website: site("glowhair"), phone: "+1 305-555-0101", rating: 4.9 },
  ],
  igProfiles: {
    "glowmiami.salon": { fullName: "Glow Hair Studio", biography: "Hair salon in Miami · balayage, color & cuts · book online", externalUrl: site("glowhair"), businessEmail: mail("hello", "glowhair"), businessCategoryName: "Hair Salon", latestPosts: [{ locationName: "Miami, Florida" }] },
    "curlhouse.mia": { fullName: "Curl House", biography: "Curly hair specialists · Miami, FL · DM to book", businessCategoryName: "Hair Salon" },
    "studio.lumiere.hair": { fullName: "Studio Lumière", biography: "Color · cuts · extensions ✨ Book via link", externalUrl: site("studiolumiere"), businessCategoryName: "Hair Salon" },
    "blowout.bar.co": { fullName: "The Blowout Bar", biography: "Blowouts & bridal hair · walk-ins welcome", businessCategoryName: "Beauty Salon", latestPosts: [{ locationName: "Wynwood, Miami", caption: "Saturday blowouts" }, { locationName: "Wynwood Walls" }] },
    "brickell.blonde.studio": { fullName: "Brickell Blonde Studio", biography: "Blonde specialists in Brickell 💛 by appointment", businessCategoryName: "Hair Salon" },
    "salonvee.miami": { fullName: "Salon Vee", biography: "Hair & color ✂️ new clients welcome", businessCategoryName: "Hair Salon" },
    "thehairloft_": { fullName: "The Hair Loft", biography: "Cuts & color" },
    "melrose.hair.la": { fullName: "Melrose Hair Co", biography: "Hair salon on Melrose Ave, Los Angeles", businessEmail: mail("book", "melrosehair"), businessCategoryName: "Hair Salon" },
    "silkpro.haircare": { fullName: "SilkPro Haircare", biography: "Professional hair care products · Miami-based brand · ships worldwide", businessEmail: "wholesale@silkpro-audit.netlify.app", businessCategoryName: "Health/Beauty" },
    "miami.nails.spa": { fullName: "Miami Nails & Spa", biography: "Nail salon in Miami · gel · acrylic · pedicure", businessEmail: "hi@miaminails-audit.netlify.app", businessCategoryName: "Nail Salon" },
  },
  igHashtagPosts: [
    { ownerUsername: "glowmiami.salon", caption: "Fresh balayage for fall #miamihair", locationName: "Miami, Florida", shortcode: "Cg1" },
    { ownerUsername: "glowmiami.salon", caption: "Another happy client #hairsalon", shortcode: "Cg2" },
    { ownerUsername: "curlhouse.mia", caption: "Curls on curls #curlyhair #hairsalon", shortcode: "Cc1" },
    { ownerUsername: "studio.lumiere.hair", caption: "Color correction day #hairsalon", shortcode: "Cs1" },
    { ownerUsername: "blowout.bar.co", caption: "Bridal trial today #hairsalon", shortcode: "Cb1" },
    { ownerUsername: "brickell.blonde.studio", caption: "Icy blonde #blondespecialist #hairsalon", shortcode: "Cbb1" },
    { ownerUsername: "salonvee.miami", caption: "New client special this week #hairsalon", shortcode: "Cv1" },
    { ownerUsername: "thehairloft_", caption: "Fresh cut #hairsalon", shortcode: "Cl1" },
    { ownerUsername: "melrose.hair.la", caption: "Melrose vibes #hairsalon", shortcode: "Cm1" },
    { ownerUsername: "silkpro.haircare", caption: "Our new argan serum is here #hairsalon #miamihairsalon", shortcode: "Csp1" },
  ],
  igSearch: ["glowmiami.salon", "curlhouse.mia", "miami.nails.spa", "brickell.blonde.studio", "silkpro.haircare", "salonvee.miami"],
  facebookPages: [
    { facebookUrl: "https://www.facebook.com/salonbellamiami", pageUrl: "https://www.facebook.com/salonbellamiami", pageId: "9001", title: "Salon Bella Miami", categories: ["Page", "Hair Salon"], address: "1200 Biscayne Blvd, Miami, FL", email: mail("book", "salonbella"), website: site("salonbella") },
  ],
  linkedinCompanies: [],
  linkedinPeople: [],
  tinyfish: (query) => /salon|hair/i.test(query)
    ? [
        { title: "Top 10 Best Hair Salons in Miami, FL - Yelp", url: "https://www.yelp.com/search?find_desc=Hair+Salons&find_loc=Miami%2C+FL", snippet: "Wynwood Hair Lounge, Salon Bella Miami, Glow Hair Studio …" },
        { title: "Studio Lumière Hair Salon", url: site("studiolumiere"), snippet: "Hair salon at 2450 Coral Way, Miami" },
        { title: "Curl House (@curlhouse.mia) • Instagram", url: "https://www.instagram.com/curlhouse.mia/", snippet: "Curly hair specialists · Miami, FL" },
        { title: "Melrose Hair Co", url: site("melrosehair"), snippet: "Hair salon on Melrose Ave, Los Angeles" },
      ]
    : [],
  sites: c1Sites,
  truth: [
    { key: /glowmiami\.salon|glow hair studio/i, label: "match", why: "bio and post location name Miami; a hair salon" },
    { key: /curlhouse\.mia|curl house/i, label: "match", why: "bio says Miami, FL; a hair salon" },
    { key: /studio\.lumiere\.hair|studio lumi/i, label: "match_website", why: "its own website gives a Coral Way, Miami address" },
    { key: /blowout\.bar\.co|blowout bar/i, label: "match_provider_field", why: "Apify latestPosts locationName 'Wynwood, Miami' (not stored by AgentSDR)" },
    { key: /brickell\.blonde|brickell blonde/i, label: "match_neighbourhood", why: "bio names Brickell, a Miami neighbourhood" },
    { key: /salonvee\.miami|salon vee/i, label: "unverified", why: "only the handle says miami" },
    { key: /thehairloft_|hair loft/i, label: "unknown", why: "nothing places it" },
    { key: /melrose/i, label: "no_match_city", why: "Los Angeles" },
    { key: /silkpro/i, label: "no_match_kind", why: "a hair-product brand, not a salon" },
    { key: /miami\.nails|nails & spa/i, label: "no_match_kind", why: "a nail salon" },
    { key: /salon bella/i, label: "match", why: "Maps: hair salon on Biscayne Blvd, Miami" },
    { key: /supercuts/i, label: "match", why: "Maps: hair salon in Miami" },
    { key: /wynwood hair/i, label: "match", why: "Maps: hair salon in Wynwood, Miami" },
    { key: /sally beauty/i, label: "no_match_kind", why: "a beauty supply store" },
    { key: /las olas/i, label: "no_match_city", why: "Fort Lauderdale" },
  ],
};

// ── Case 2: B2B buyers without a city ────────────────────────────────────────

const C2: CaseFixture = {
  id: "c2",
  title: "B2B buyers without a city",
  prompt: "Find CTOs at fintech startups and email them",
  followUp: "Anywhere, they are mostly remote. US-based is fine.",
  profile: { businessName: "LedgerShield", offer: "SOC 2 and PCI compliance automation for fintech startups", targetCustomers: "fintech startups", senderName: "Ravi" },
  senders: { email: true, linkedin: true },
  expect: { contact: true, channels: ["email"], target: null, minMatches: 1, planPossible: true },
  maps: () => [
    { title: "Chase Bank", category: "Bank", address: "270 Park Ave, New York, NY", city: "New York", website: site("chasebranch"), phone: "+1 212-555-0120" },
    { title: "Wells Fargo ATM", category: "ATM", address: "150 E 42nd St, New York, NY", city: "New York" },
    { title: "PayNest", category: "Software company", address: "85 Broad St, New York, NY", city: "New York", website: site("paynest") },
    { title: "Coinstar Kiosk", category: "Coin dealer", address: "Union Sq, New York, NY", city: "New York" },
  ],
  igProfiles: {},
  igHashtagPosts: [],
  igSearch: [],
  facebookPages: [],
  linkedinCompanies: [
    { id: "1001", name: "LedgerLoop", linkedinUrl: "https://www.linkedin.com/company/ledgerloop/", website: site("ledgerloop"), industries: [{ name: "Financial Services" }], headquarter: { city: "San Francisco", country: "US" } },
    { id: "1002", name: "PayNest", linkedinUrl: "https://www.linkedin.com/company/paynest/", website: site("paynest"), industries: [{ name: "Financial Services" }], headquarter: { city: "New York", country: "US" } },
    { id: "1003", name: "MediSync", linkedinUrl: "https://www.linkedin.com/company/medisync/", website: site("medisync"), industries: [{ name: "Hospitals and Health Care" }], headquarter: { city: "Boston", country: "US" } },
  ],
  linkedinPeople: [
    { profileUrl: "https://www.linkedin.com/in/priya-raman-ll/", name: "Priya Raman", headline: "Co-founder & CTO at LedgerLoop (YC W24) | Payments infrastructure", companyName: "LedgerLoop", location: "San Francisco Bay Area" },
    { profileUrl: "https://www.linkedin.com/in/marcus-lee-pn/", name: "Marcus Lee", headline: "Chief Technology Officer @ PayNest — embedded finance APIs", companyName: "PayNest", location: "New York, New York, United States" },
    { profileUrl: "https://www.linkedin.com/in/dana-kim-ms/", name: "Dana Kim", headline: "CTO at MediSync (healthtech)", companyName: "MediSync", location: "Boston, MA" },
    { profileUrl: "https://www.linkedin.com/in/alex-novak-fcto/", name: "Alex Novak", headline: "Fractional CTO for fintech startups | Advisor", companyName: null, location: "Austin, Texas" },
    { profileUrl: "https://www.linkedin.com/in/omar-haddad-cv/", name: "Omar Haddad", headline: "VP Engineering at CoinVault", companyName: "CoinVault", location: "Miami, FL" },
    { profileUrl: "https://www.linkedin.com/in/priya-raman-ll/", name: "Priya Raman", headline: "Co-founder & CTO at LedgerLoop (YC W24) | Payments infrastructure", companyName: "LedgerLoop", location: "San Francisco Bay Area" },
    { profileUrl: "https://www.linkedin.com/in/lena-fischer-st/", name: "Lena Fischer", headline: "CTO | Fintech", companyName: "Stealth", location: null },
  ],
  tinyfish: (query) => /fintech|cto|payments|startup/i.test(query)
    ? [
        { title: "Fintech startups funded by Y Combinator", url: "https://www.ycombinator.com/companies/industry/fintech", snippet: "LedgerLoop, PayNest, CoinVault …" },
        { title: "LedgerLoop — Team", url: `${site("ledgerloop")}team`, snippet: "Priya Raman, Co-founder & CTO" },
        { title: "PayNest — About", url: `${site("paynest")}about`, snippet: "Leadership: Marcus Lee, CTO" },
        { title: "Priya Raman - CTO - LedgerLoop | LinkedIn", url: "https://www.linkedin.com/in/priya-raman-ll/", snippet: "Co-founder & CTO at LedgerLoop" },
        { title: "MediSync — Team", url: `${site("medisync")}team`, snippet: "Dana Kim, CTO" },
        { title: "Best payment APIs in 2026 (blog)", url: `${site("paymentsblog")}best-apis`, snippet: "A roundup of payment APIs" },
      ]
    : [],
  sites: {
    [site("ledgerloop")]: page("LedgerLoop — payments infrastructure for marketplaces", "<p>LedgerLoop is a YC W24 fintech startup in San Francisco.</p>", [`${site("ledgerloop")}team`]),
    [`${site("ledgerloop")}team`]: page("LedgerLoop — Team", `<h3>Priya Raman</h3><p>Co-founder &amp; CTO</p><a href="mailto:${mail("priya", "ledgerloop")}">${mail("priya", "ledgerloop")}</a><h3>Tom Hale</h3><p>CEO</p>`),
    [site("paynest")]: page("PayNest — embedded finance APIs", "<p>Fintech startup in New York.</p>", [`${site("paynest")}about`]),
    [`${site("paynest")}about`]: page("PayNest — About", `<h3>Marcus Lee</h3><p>CTO</p><a href="mailto:${mail("marcus.lee", "paynest")}">${mail("marcus.lee", "paynest")}</a>`),
    [site("medisync")]: page("MediSync — healthtech scheduling", "<p>Healthtech in Boston.</p>", [`${site("medisync")}team`]),
    [`${site("medisync")}team`]: page("MediSync — Team", `<h3>Dana Kim</h3><p>CTO</p><a href="mailto:${mail("dana", "medisync")}">${mail("dana", "medisync")}</a>`),
    [site("chasebranch")]: page("Chase Bank branch", `<p>Personal banking.</p><a href="mailto:${mail("branch", "chasebranch")}">${mail("branch", "chasebranch")}</a>`),
    [`${site("paymentsblog")}best-apis`]: page("Best payment APIs in 2026", "<p>A roundup by a blogger.</p>"),
    ["https://www.ycombinator.com/companies/industry/fintech"]: page("Fintech startups funded by Y Combinator", `<ul><li><a href="${site("ledgerloop")}">LedgerLoop</a></li><li><a href="${site("paynest")}">PayNest</a></li></ul>`),
  },
  truth: [
    { key: /priya/i, label: "match", why: "CTO of LedgerLoop, a fintech startup" },
    { key: /marcus/i, label: "match", why: "CTO of PayNest, a fintech startup" },
    { key: /dana kim|medisync/i, label: "no_match_kind", why: "healthtech, not fintech" },
    { key: /alex novak/i, label: "no_match_role", why: "a fractional CTO / advisor, not a CTO at a startup" },
    { key: /omar|coinvault/i, label: "no_match_role", why: "VP Engineering, not CTO" },
    { key: /lena/i, label: "unverified", why: "'CTO | Fintech' at Stealth: company unknown" },
    { key: /chase|wells fargo|coinstar/i, label: "no_match_kind", why: "a bank branch / ATM / kiosk" },
    { key: /ledgerloop/i, label: "match", why: "fintech startup (company record)" },
    { key: /paynest/i, label: "match", why: "fintech startup (company record)" },
  ],
};

// ── Case 3: weak initial results ─────────────────────────────────────────────

const C3_WEAK: MapsRow[] = [
  { title: "Austin Photo Booth Co", category: "Photo booth rental", address: "2100 E 6th St, Austin, TX", city: "Austin", website: site("atxphotobooth") },
  { title: "Precision Camera", category: "Camera store", address: "2438 W Anderson Ln, Austin, TX", city: "Austin", website: site("precisioncamera") },
  { title: "Lone Star Family Portraits", category: "Portrait studio", address: "4000 N Lamar Blvd, Austin, TX", city: "Austin", website: site("lonestarportraits") },
  { title: "Houston Wedding Films", category: "Videographer", address: "1200 Westheimer Rd, Houston, TX", city: "Houston", website: site("houstonweddingfilms") },
  { title: "Bella Bridal Boutique", category: "Bridal shop", address: "5400 Burnet Rd, Austin, TX", city: "Austin", website: site("bellabridal") },
  { title: "Jenna Kay Wedding Photography", category: "Wedding photographer", address: "1600 S Congress Ave, Austin, TX", city: "Austin", website: site("jennakay") },
];
const C3_GOOD: MapsRow[] = [
  { title: "Hill Country Wedding Photo", category: "Wedding photographer", address: "800 W 5th St, Austin, TX", city: "Austin", website: site("hillcountrywed") },
  { title: "Golden Hour Weddings ATX", category: "Wedding photographer", address: "1100 E 11th St, Austin, TX", city: "Austin", website: site("goldenhouratx") },
  { title: "Mae & Co Photography", category: "Wedding photographer", address: "2200 S Lamar Blvd, Austin, TX", city: "Austin", website: site("maeandco") },
  { title: "Jenna Kay Wedding Photography", category: "Wedding photographer", address: "1600 S Congress Ave, Austin, TX", city: "Austin", website: site("jennakay") },
  { title: "Sam Reyes Elopement Photography", category: "Wedding photographer", address: "3300 E Cesar Chavez St, Austin, TX", city: "Austin", website: site("samreyes") },
  { title: "Round Rock Wedding Studio", category: "Wedding photographer", address: "100 E Main St, Round Rock, TX", city: "Round Rock", website: site("roundrockwedding") },
];
const c3Site = (slug: string, title: string, line: string) => ({ [site(slug)]: page(title, `<p>${line}</p><a href="mailto:${mail("hello", slug)}">${mail("hello", slug)}</a>`) });

const C3: CaseFixture = {
  id: "c3",
  title: "Weak initial results",
  prompt: "Find 8 wedding photographers in Austin and email them",
  followUp: "Austin, Texas. Wedding photographers only.",
  profile: { businessName: "Shotlist", offer: "Client galleries and booking software for wedding photographers", targetCustomers: "wedding photographers", locations: "Texas", senderName: "Ravi" },
  senders: { email: true },
  expect: { contact: true, channels: ["email"], target: 8, minMatches: 4, planPossible: true },
  maps: (_phrase, nth) => (nth === 0 ? C3_WEAK : C3_GOOD),
  igProfiles: {},
  igHashtagPosts: [],
  igSearch: [],
  facebookPages: [],
  linkedinCompanies: [],
  linkedinPeople: [],
  tinyfish: (query) => /wedding|photograph/i.test(query)
    ? [
        { title: "Top 10 Best Wedding Photographers in Austin, TX - Yelp", url: "https://www.yelp.com/search?find_desc=Wedding+Photographers&find_loc=Austin%2C+TX", snippet: "Hill Country Wedding Photo, Golden Hour Weddings ATX, Mae & Co …" },
        { title: "Golden Hour Weddings ATX", url: site("goldenhouratx"), snippet: "Wedding photographer in Austin" },
        { title: "Sam Reyes Elopement Photography", url: site("samreyes"), snippet: "Elopements and weddings in Austin" },
        { title: "Lone Star Family Portraits", url: site("lonestarportraits"), snippet: "Family portraits in Austin" },
      ]
    : [],
  sites: {
    ...c3Site("atxphotobooth", "Austin Photo Booth Co", "Photo booth rental for parties and weddings in Austin, TX."),
    ...c3Site("precisioncamera", "Precision Camera", "Camera store in Austin, TX: cameras, lenses, repairs."),
    ...c3Site("lonestarportraits", "Lone Star Family Portraits", "Family and newborn portraits in Austin, TX."),
    ...c3Site("houstonweddingfilms", "Houston Wedding Films", "Wedding videography in Houston, TX."),
    ...c3Site("bellabridal", "Bella Bridal Boutique", "Wedding dresses in Austin, TX."),
    ...c3Site("jennakay", "Jenna Kay Wedding Photography", "Wedding photographer in Austin, TX."),
    ...c3Site("hillcountrywed", "Hill Country Wedding Photo", "Wedding photography in Austin and the Hill Country."),
    ...c3Site("goldenhouratx", "Golden Hour Weddings ATX", "Wedding photographer based in Austin, TX."),
    ...c3Site("maeandco", "Mae & Co Photography", "Austin wedding and engagement photographer."),
    ...c3Site("samreyes", "Sam Reyes Elopement Photography", "Elopement and wedding photographer in Austin, TX."),
    ...c3Site("roundrockwedding", "Round Rock Wedding Studio", "Wedding photography in Round Rock, TX."),
    ["https://www.yelp.com/search?find_desc=Wedding+Photographers&find_loc=Austin%2C+TX"]: page("Top 10 Best Wedding Photographers in Austin, TX", `<ol><li><a href="${site("hillcountrywed")}">Hill Country Wedding Photo</a></li><li><a href="${site("goldenhouratx")}">Golden Hour Weddings ATX</a></li><li><a href="${site("maeandco")}">Mae &amp; Co Photography</a></li><li><a href="${site("samreyes")}">Sam Reyes</a></li></ol>`),
  },
  truth: [
    { key: /photo booth/i, label: "no_match_kind", why: "photo booth rental" },
    { key: /precision camera/i, label: "no_match_kind", why: "camera store" },
    { key: /family portraits/i, label: "no_match_kind", why: "family portrait studio" },
    { key: /houston/i, label: "no_match_city", why: "Houston videographer" },
    { key: /bridal boutique/i, label: "no_match_kind", why: "bridal shop" },
    { key: /jenna kay/i, label: "match", why: "Austin wedding photographer" },
    { key: /hill country/i, label: "match", why: "Austin wedding photographer" },
    { key: /golden hour/i, label: "match", why: "Austin wedding photographer" },
    { key: /mae & co|mae &amp; co/i, label: "match", why: "Austin wedding photographer" },
    { key: /sam reyes/i, label: "match", why: "Austin wedding photographer" },
    { key: /round rock/i, label: "no_match_city", why: "Round Rock, not Austin" },
  ],
};

// ── Case 4: research-only provider test ──────────────────────────────────────

const dentists = ["Barton Creek Dental", "South Lamar Smiles", "Mueller Family Dentistry", "Tarrytown Dental Care", "Domain Dental Studio", "Zilker Park Dentistry", "Hyde Park Dental", "Riverside Smiles"];
const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "");
const C4: CaseFixture = {
  id: "c4",
  title: "Research-only provider test",
  prompt: "Research only. Test Google Maps and the web search with 5 results each for dentists in Austin. No outreach.",
  followUp: "Austin, Texas. Just run the two tests.",
  profile: { businessName: "ChairFill", offer: "WhatsApp appointment reminders that fill empty chair hours for dental clinics", targetCustomers: "dental clinics", locations: "Texas", senderName: "Ravi" },
  senders: {},
  expect: { contact: false, channels: null, target: null, maxSearches: 2, minMatches: 3, planPossible: false, endsDone: true },
  maps: () => dentists.map((name, index) => ({ title: name, category: "Dentist", address: `${100 + index} Congress Ave, Austin, TX`, city: "Austin", website: site(slugOf(name)), phone: `+1 512-555-01${String(20 + index)}` })),
  igProfiles: {},
  igHashtagPosts: [],
  igSearch: [],
  facebookPages: [],
  linkedinCompanies: [],
  linkedinPeople: [],
  tinyfish: (query) => /dent/i.test(query)
    ? [
        { title: "Top 10 Best Dentists in Austin, TX - Yelp", url: "https://www.yelp.com/search?find_desc=Dentists&find_loc=Austin%2C+TX", snippet: "Barton Creek Dental, Hyde Park Dental …" },
        ...dentists.slice(3).map((name) => ({ title: name, url: site(slugOf(name)), snippet: `${name} — family dentist in Austin, TX` })),
      ]
    : [],
  sites: {
    ...Object.fromEntries(dentists.map((name) => [site(slugOf(name)), page(name, `<p>${name}, family and cosmetic dentistry in Austin, TX.</p><a href="mailto:${mail("front", slugOf(name))}">${mail("front", slugOf(name))}</a>`)])),
    ["https://www.yelp.com/search?find_desc=Dentists&find_loc=Austin%2C+TX"]: page("Top 10 Best Dentists in Austin, TX", `<ol>${dentists.map((name) => `<li><a href="${site(slugOf(name))}">${name}</a></li>`).join("")}</ol>`),
  },
  truth: dentists.map((name) => ({ key: new RegExp(name, "i"), label: "match" as const, why: "Austin dentist" })),
};

// ── Case 5: free-only request ────────────────────────────────────────────────

const C5: CaseFixture = {
  id: "c5",
  title: "Free-only request",
  prompt: "Find 5 yoga studios in Denver using free sources only, $0.",
  followUp: "Denver, Colorado. Free sources only.",
  profile: { businessName: "FlowDesk", offer: "Class booking and membership software for yoga studios", targetCustomers: "yoga studios", locations: "Colorado", senderName: "Ravi" },
  senders: {},
  expect: { contact: false, channels: null, target: 5, noPaid: true, minMatches: 3, planPossible: false },
  maps: (_phrase, nth) => nth === 0
    ? [
        { title: "Highland Yoga Denver", category: "Yoga studio", address: "3200 W 32nd Ave, Denver, CO", city: "Denver", website: site("highlandyoga") },
        { title: "RiNo Hot Yoga", category: "Yoga studio", address: "2800 Larimer St, Denver, CO", city: "Denver", website: site("rinohotyoga") },
        { title: "Wash Park Yoga", category: "Yoga studio", address: "700 S Downing St, Denver, CO", city: "Denver", phone: "+1 303-555-0130" },
        { title: "CorePower Yoga Boulder", category: "Yoga studio", address: "1600 Pearl St, Boulder, CO", city: "Boulder", website: site("corepowerboulder") },
        { title: "Yoga Mat Outlet", category: "Sporting goods store", address: "1000 Broadway, Denver, CO", city: "Denver", website: site("yogamatoutlet") },
        { title: "Capitol Hill Yoga Collective", category: "Yoga studio", address: "1300 E Colfax Ave, Denver, CO", city: "Denver", website: site("caphillyoga") },
      ]
    : [
        { title: "Sloan's Lake Yoga", category: "Yoga studio", address: "1700 Sheridan Blvd, Denver, CO", city: "Denver", website: site("sloanslakeyoga") },
        { title: "Highland Yoga Denver", category: "Yoga studio", address: "3200 W 32nd Ave, Denver, CO", city: "Denver", website: site("highlandyoga") },
      ],
  igProfiles: {
    "denveryogaloft": { fullName: "Denver Yoga Loft", biography: "Vinyasa & yin in Denver, CO", businessEmail: "loft@denveryogaloft-audit.netlify.app", businessCategoryName: "Yoga Studio" },
  },
  igHashtagPosts: [{ ownerUsername: "denveryogaloft", caption: "Sunrise flow #denveryoga", shortcode: "Cy1" }],
  igSearch: ["denveryogaloft"],
  facebookPages: [],
  linkedinCompanies: [],
  linkedinPeople: [],
  tinyfish: (query) => /yoga/i.test(query)
    ? [
        { title: "Top 10 Best Yoga Studios in Denver, CO - Yelp", url: "https://www.yelp.com/search?find_desc=Yoga+Studios&find_loc=Denver%2C+CO", snippet: "Highland Yoga, Sloan's Lake Yoga, Cherry Creek Yoga …" },
        { title: "Cherry Creek Yoga", url: site("cherrycreekyoga"), snippet: "Yoga studio in Cherry Creek, Denver" },
        { title: "Sloan's Lake Yoga", url: site("sloanslakeyoga"), snippet: "Yoga by the lake in Denver" },
      ]
    : [],
  sites: {
    [site("highlandyoga")]: page("Highland Yoga Denver", `<p>Yoga studio in the Highland neighborhood of Denver, CO.</p><a href="mailto:${mail("hello", "highlandyoga")}">${mail("hello", "highlandyoga")}</a>`),
    [site("rinohotyoga")]: page("RiNo Hot Yoga", `<p>Hot yoga in RiNo, Denver, CO.</p><a href="mailto:${mail("namaste", "rinohotyoga")}">${mail("namaste", "rinohotyoga")}</a>`),
    [site("corepowerboulder")]: page("CorePower Yoga Boulder", `<p>Yoga studio on Pearl St, Boulder, CO.</p><a href="mailto:${mail("boulder", "corepowerboulder")}">${mail("boulder", "corepowerboulder")}</a>`),
    [site("yogamatoutlet")]: page("Yoga Mat Outlet", `<p>Yoga mats, blocks and apparel. Store in Denver, CO.</p><a href="mailto:${mail("sales", "yogamatoutlet")}">${mail("sales", "yogamatoutlet")}</a>`),
    [site("caphillyoga")]: page("Capitol Hill Yoga Collective", `<p>Community yoga studio on Colfax, Denver, CO.</p><a href="mailto:${mail("collective", "caphillyoga")}">${mail("collective", "caphillyoga")}</a>`),
    [site("sloanslakeyoga")]: page("Sloan's Lake Yoga", `<p>Yoga studio by Sloan's Lake, Denver, CO.</p><a href="mailto:${mail("hi", "sloanslakeyoga")}">${mail("hi", "sloanslakeyoga")}</a>`),
    [site("cherrycreekyoga")]: page("Cherry Creek Yoga", `<p>Yoga studio in Cherry Creek, Denver, CO.</p><a href="mailto:${mail("om", "cherrycreekyoga")}">${mail("om", "cherrycreekyoga")}</a>`),
    ["https://www.yelp.com/search?find_desc=Yoga+Studios&find_loc=Denver%2C+CO"]: page("Top 10 Best Yoga Studios in Denver, CO", `<ol><li><a href="${site("highlandyoga")}">Highland Yoga</a></li><li><a href="${site("sloanslakeyoga")}">Sloan's Lake Yoga</a></li><li><a href="${site("cherrycreekyoga")}">Cherry Creek Yoga</a></li></ol>`),
  },
  truth: [
    { key: /highland yoga/i, label: "match", why: "Denver yoga studio" },
    { key: /rino hot yoga/i, label: "match", why: "Denver yoga studio" },
    { key: /wash park yoga/i, label: "match", why: "Denver yoga studio (phone only)" },
    { key: /corepower/i, label: "no_match_city", why: "Boulder" },
    { key: /yoga mat outlet/i, label: "no_match_kind", why: "a store" },
    { key: /capitol hill yoga/i, label: "match", why: "Denver yoga studio" },
    { key: /sloan/i, label: "match", why: "Denver yoga studio" },
    { key: /cherry creek/i, label: "match", why: "Denver yoga studio" },
    { key: /denver yoga loft|denveryogaloft/i, label: "match", why: "Denver yoga studio (Instagram, paid source)" },
  ],
};

// ── Case 7: a vague kind of business, the profile says which ─────────────────

const nyClinics: (MapsRow & { email: boolean })[] = [
  { title: "Madison Avenue Dental", category: "Dentist", address: "575 Madison Ave, New York, NY 10022", city: "New York", website: site("madisonavedental"), email: true },
  { title: "Brooklyn Heights Dental Care", category: "Dentist", address: "130 Montague St, Brooklyn, NY 11201", city: "Brooklyn", website: site("bkheightsdental"), email: true },
  { title: "Upper West Side Smiles", category: "Dentist", address: "2400 Broadway, New York, NY 10024", city: "New York", website: site("uwssmiles"), email: true },
  { title: "Chelsea Family Dentistry", category: "Dentist", address: "200 W 23rd St, New York, NY 10011", city: "New York", phone: "+1 212-555-0144", email: false },
  { title: "Astoria Dental Group", category: "Dental clinic", address: "31-10 Ditmars Blvd, Astoria, NY 11105", city: "Astoria", website: site("astoriadental"), email: true },
  { title: "Henry Schein Dental Supply", category: "Dental supply store", address: "1 Penn Plaza, New York, NY 10119", city: "New York", website: site("scheinsupply"), email: true },
  { title: "Jersey City Dental Studio", category: "Dentist", address: "30 Montgomery St, Jersey City, NJ 07302", city: "Jersey City", website: site("jcdentalstudio"), email: true },
];
const C7: CaseFixture = {
  id: "c7",
  title: "A vague kind of business; the profile says which",
  prompt: "Find 5 businesses in New York and email them",
  followUp: "Dental clinics in New York City. Email them.",
  profile: { businessName: "ChairFill", offer: "Automatic appointment reminders that cut no-shows for dental clinics", targetCustomers: "dental clinics", locations: "New York", senderName: "Ravi" },
  senders: { email: true },
  expect: { contact: true, channels: ["email"], target: 5, minMatches: 3, planPossible: true },
  maps: (phrase) => [
    ...nyClinics.map(({ title, category, address, city, website, phone }) => ({ title, category, address, city, website, phone })),
    ...(/dent/i.test(phrase) ? [] : [
      { title: "Joe's Pizza", category: "Pizza restaurant", address: "7 Carmine St, New York, NY 10014", city: "New York", website: site("joespizzanyc") },
      { title: "Hudson Legal Group", category: "Law firm", address: "100 Wall St, New York, NY 10005", city: "New York", website: site("hudsonlegal") },
    ]),
  ],
  igProfiles: {},
  igHashtagPosts: [],
  igSearch: [],
  facebookPages: [],
  linkedinCompanies: [],
  linkedinPeople: [],
  tinyfish: (query) => /dent/i.test(query)
    ? [
        { title: "Top 10 Best Dentists in New York, NY - Yelp", url: "https://www.yelp.com/search?find_desc=Dentists&find_loc=New+York%2C+NY", snippet: "Madison Avenue Dental, Upper West Side Smiles, Astoria Dental Group …" },
        { title: "Upper West Side Smiles", url: site("uwssmiles"), snippet: "Family dentist on Broadway, New York" },
        { title: "Jersey City Dental Studio", url: site("jcdentalstudio"), snippet: "Dentist in downtown Jersey City, NJ" },
      ]
    : [],
  sites: {
    ...Object.fromEntries(nyClinics.filter((row) => row.website).map((row) => {
      const slug = new URL(row.website!).hostname.replace(/-audit\.netlify\.app$/, "");
      return [row.website!, page(row.title, `<p>${row.title} — ${row.category.toLowerCase()} at ${row.address}.</p>${row.email ? `<a href="mailto:${mail("frontdesk", slug)}">${mail("frontdesk", slug)}</a>` : ""}`)];
    })),
    [site("joespizzanyc")]: page("Joe's Pizza", `<p>Pizza by the slice since 1975.</p><a href="mailto:${mail("hi", "joespizzanyc")}">${mail("hi", "joespizzanyc")}</a>`),
    [site("hudsonlegal")]: page("Hudson Legal Group", `<p>Corporate law firm on Wall St.</p><a href="mailto:${mail("intake", "hudsonlegal")}">${mail("intake", "hudsonlegal")}</a>`),
    ["https://www.yelp.com/search?find_desc=Dentists&find_loc=New+York%2C+NY"]: page("Top 10 Best Dentists in New York, NY", `<ol><li><a href="${site("madisonavedental")}">Madison Avenue Dental</a></li><li><a href="${site("uwssmiles")}">Upper West Side Smiles</a></li><li><a href="${site("astoriadental")}">Astoria Dental Group</a></li></ol>`),
  },
  truth: [
    { key: /madison avenue dental/i, label: "match", why: "dental clinic in Manhattan" },
    { key: /brooklyn heights dental/i, label: "match", why: "dental clinic in Brooklyn, New York City" },
    { key: /upper west side smiles/i, label: "match", why: "dental clinic in Manhattan" },
    { key: /chelsea family dentistry/i, label: "match", why: "dental clinic in Manhattan (phone only, no email)" },
    { key: /astoria dental/i, label: "match", why: "dental clinic in Queens, New York City" },
    { key: /henry schein|dental supply/i, label: "no_match_kind", why: "a dental supply store" },
    { key: /jersey city/i, label: "no_match_city", why: "Jersey City, New Jersey" },
    { key: /joe's pizza|pizza/i, label: "no_match_kind", why: "a restaurant" },
    { key: /hudson legal/i, label: "no_match_kind", why: "a law firm" },
  ],
};

export const CASES: Record<string, CaseFixture> = {
  c1: C1,
  c2: C2,
  c3: C3,
  c4: C4,
  c5: C5,
  c5b: { ...C5, id: "c5b", title: "Free-only request, other wording", prompt: "Find 5 yoga studios in Denver. Use only free tools." },
  // The place arrives only in the answer to the assistant's question.
  c6: { ...C1, id: "c6", title: "The city comes in a clarification", prompt: "Find 10 hair salons on Instagram and DM them", followUp: "Miami." },
  c7: C7,
  // Instagram asked for, no Instagram account linked, a mailbox ready: no email plan may stand in for the DMs.
  c8: { ...C1, id: "c8", title: "Instagram asked for, no Instagram sender", senders: { email: true }, expect: { ...C1.expect, planPossible: false } },
};

export function truthOf(fixture: CaseFixture, text: string): Truth | null {
  return fixture.truth.find((item) => item.key.test(text)) ?? null;
}
