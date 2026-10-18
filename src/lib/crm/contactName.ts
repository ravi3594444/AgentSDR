/**
 * The name a list shows for a contact. A person's own name when it is known;
 * otherwise the business and the route the conversation reaches them on
 * ("Bright Path Dental · +919812345678"), so an unnamed lead is still
 * recognisable instead of "Unknown contact". Nothing is invented: every part
 * comes from the record. Pure and client-safe; the CRM lists, the record
 * page and Activity's replies use it.
 */

export type ContactNameParts = {
  fullName?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  /** The linked company's name, or a business name kept on the person. */
  company?: unknown;
  email?: unknown;
  phone?: unknown;
  /** Instagram username, with or without the @. */
  instagram?: unknown;
  /** LinkedIn slug or profile URL. */
  linkedin?: unknown;
  /** The conversation's channel: its route is named first. */
  channel?: unknown;
};

export const UNKNOWN_CONTACT = "Unknown contact";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The contact routes known for a person, the channel's own first. */
export function contactRoutes(parts: ContactNameParts): string[] {
  const linkedin = text(parts.linkedin);
  const instagram = text(parts.instagram).replace(/^@/, "");
  const byChannel: Record<string, string> = {
    whatsapp: text(parts.phone),
    email: text(parts.email),
    instagram: instagram ? `@${instagram}` : "",
    linkedin: linkedin ? `LinkedIn · ${linkedin.replace(/\/+$/, "").split("/").pop() || linkedin}` : "",
  };
  const order = ["whatsapp", "email", "instagram", "linkedin"];
  const first = text(parts.channel);
  return [...(first in byChannel ? [first] : []), ...order.filter((key) => key !== first)]
    .map((key) => byChannel[key]!)
    .filter(Boolean);
}

export function contactDisplayName(parts: ContactNameParts): string {
  const name = text(parts.fullName) || `${text(parts.firstName)} ${text(parts.lastName)}`.trim();
  if (name) return name;
  const business = text(parts.company);
  const route = contactRoutes(parts)[0] ?? "";
  if (business && route) return `${business} · ${route}`;
  return business || route || UNKNOWN_CONTACT;
}
