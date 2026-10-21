/**
 * What a lead is called on screen, without inventing anyone. Pure and
 * client-safe (Leads > People and the server's lead-list naming share it).
 *
 * Discovery saves a business without a person's name: people.full_name
 * stays null unless the address belongs to someone the website names. The
 * business is kept as a company association instead — the linked
 * companies row when it has a domain, otherwise raw.company /
 * raw.companyName (records.ts upsertPerson / createProvisionalPerson).
 * That association is what a nameless lead is shown by. raw.businessName
 * alone never is: for a directory contact it is "+91… (listed on x)", and
 * for a Reddit or X author it is their username.
 */

export type NameSource = {
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  raw?: Record<string, unknown> | null;
};

export type CompanySource = { name?: string | null; domain?: string | null } | null | undefined;

export type LeadLabel = {
  /** person: their own name; company: the company they are saved under; unknown: neither. */
  kind: "person" | "company" | "unknown";
  name: string;
  /** For a company or unknown label, the line under it; a person's line is the caller's (their title). */
  secondary: string | null;
};

export const UNNAMED_PERSON = "Unnamed person";
export const NO_CONTACT_PERSON = "No contact person named";
const UNNAMED_LEAD = "Unnamed lead";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The person's own name: their full name, else first and last. */
export function ownName(person: NameSource): string | null {
  return text(person.fullName) ?? text([text(person.firstName), text(person.lastName)].filter(Boolean).join(" "));
}

/** The company's name they are associated with: the linked row's, else the one raw kept when no row could be linked. */
export function companyName(person: NameSource, company: CompanySource): string | null {
  return text(company?.name) ?? text(person.raw?.company) ?? text(person.raw?.companyName);
}

function instagramHandle(person: NameSource): string | null {
  const instagram = person.raw?.instagram;
  const username = instagram && typeof instagram === "object" ? text((instagram as { username?: unknown }).username) : null;
  return username ? username.replace(/^@/, "") || null : null;
}

function linkedinHandle(value: string): string {
  const handle = value.replace(/^.*\/in\//i, "").replace(/[/?#].*$/, "");
  return `linkedin.com/in/${handle}`;
}

/** The first way to reach them (email, phone, LinkedIn, Instagram), as the line under a nameless lead. */
export function firstRoute(person: NameSource): string | null {
  const linkedin = text(person.linkedinUrl);
  const instagram = instagramHandle(person);
  return text(person.email) ?? text(person.phone) ?? (linkedin ? linkedinHandle(linkedin) : null) ?? (instagram ? `@${instagram}` : null);
}

/** How Leads names a row: their own name; else their company with "No contact person named"; else "Unnamed person" over their first route. */
export function leadLabel(person: NameSource, company: CompanySource): LeadLabel {
  const own = ownName(person);
  if (own) return { kind: "person", name: own, secondary: null };
  const business = companyName(person, company) ?? text(company?.domain);
  if (business) return { kind: "company", name: business, secondary: NO_CONTACT_PERSON };
  return { kind: "unknown", name: UNNAMED_PERSON, secondary: firstRoute(person) };
}

/**
 * What a new lead-list member is called (lead_audience_members.name): their
 * own name, the business they are saved under, their email or phone, the
 * save path's own label, their Instagram username, else "Unnamed lead".
 * `instagram` is the parsed username when the caller has it.
 */
export function memberName(person: NameSource, company: CompanySource, instagram: string | null = instagramHandle(person)): string {
  return ownName(person)
    ?? companyName(person, company)
    ?? text(person.email)
    ?? text(person.phone)
    ?? text(person.raw?.businessName)
    ?? instagram
    ?? UNNAMED_LEAD;
}

/**
 * A stored member's name as the lead list shows it now. Members saved
 * before the business came ahead of email and phone carry their route as
 * their name; those (and "Unnamed lead") are named as a new member would
 * be. Any other stored name is kept, and nothing is written back.
 */
export function prospectName(stored: string, person: NameSource | null, company: CompanySource): string {
  if (!person) return stored;
  const value = stored.trim().toLowerCase();
  const fallback = value === UNNAMED_LEAD.toLowerCase()
    || value === text(person.email)?.toLowerCase()
    || value === text(person.phone)?.toLowerCase();
  return fallback ? memberName(person, company) : stored;
}
