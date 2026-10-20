import type { AudienceChannel, OutreachPlan } from "./schema";

/**
 * Which channels a plan may use, and in what order (outreach.server.ts
 * prepareOutreach). The owner's own words decide a restriction: "message
 * them on WhatsApp", "email only", "don't email them". A channel list the
 * model passes without such words, the profile's preferred channels and an
 * earlier run's channels only set the order, so a general request keeps
 * every route a lead has: an email-only lead is still emailed when the
 * model happened to ask for WhatsApp. Each lead then gets the first ready
 * channel in the order that it can be reached on.
 */

/** Every channel a plan can use, in the default order. */
export const CHANNEL_ORDER: readonly AudienceChannel[] = ["email", "whatsapp", "linkedin", "instagram"];

export const CHANNEL_NAMES: Record<AudienceChannel, string> = { email: "email", whatsapp: "WhatsApp", linkedin: "LinkedIn", instagram: "Instagram" };

const CHANNEL = String.raw`\b(e-?mails?|whats\s?app|linked\s?in|instagram|insta)\b`;
const CONTACT_VERB = String.raw`\b(?:contact|message|reach(?:\s+out)?|pitch|outreach|write|send|dm|text|connect|invite|approach|follow\s+up|ping)\b`;
const PEOPLE = String.raw`(?:them|these|those|each|every(?:one|body)?|people|the\s+leads|him|her)`;
const NEGATION = /\b(?:don'?t|do\s+not|never|not|no|without|except|skip)\s+(?:use\s+|using\s+|send(?:ing)?\s+|any\s+)?(?:an?\s+)?$/;

function channelOf(word: string): AudienceChannel {
  const lower = word.toLowerCase().replace(/\s+/g, "");
  if (lower.startsWith("e")) return "email";
  if (lower.startsWith("whats")) return "whatsapp";
  if (lower.startsWith("linked")) return "linkedin";
  return "instagram";
}

/** The channels the owner's words ask for (`only`) and rule out (`excluded`), in the order they are named. */
export function ownerChannels(text: string): { only: AudienceChannel[]; excluded: AudienceChannel[] } {
  const words = ` ${text.replace(/\s+/g, " ")} `;
  const only: AudienceChannel[] = [];
  const excluded: AudienceChannel[] = [];
  const add = (list: AudienceChannel[], channel: AudienceChannel) => {
    if (!list.includes(channel)) list.push(channel);
  };
  const named = new RegExp(CHANNEL, "gi");
  const joiner = /^\s*(?:,|and|or|nor|\/)\s*(?:an?\s+|by\s+|via\s+|on\s+)?$/i;
  let lastContact = -1;
  let lastExcluded = -1;
  for (const match of words.matchAll(named)) {
    const at = match.index;
    const channel = channelOf(match[1]!);
    const before = words.slice(Math.max(0, at - 70), at);
    const after = words.slice(at + match[0].length, at + match[0].length + 30);
    // "don't email them", "no WhatsApp", "don't use WhatsApp or LinkedIn".
    if (NEGATION.test(before.slice(-30).toLowerCase()) || (lastExcluded >= 0 && joiner.test(words.slice(lastExcluded, at)))) {
      add(excluded, channel);
      lastExcluded = at + match[0].length;
      continue;
    }
    // "email only", "only WhatsApp", "just by email".
    const isOnly = /^\s*only\b/i.test(after) || /\b(?:only|just|solely)\s+(?:by\s+|via\s+|on\s+|through\s+|over\s+|with\s+|using\s+)?(?:an?\s+)?$/i.test(before);
    // "email them", "email or LinkedIn them": the channel used as the verb for the people.
    const asVerb = new RegExp(String.raw`^(?:\s*(?:,|and|or|/)\s*${CHANNEL})*\s+${PEOPLE}\b`, "i").test(after);
    // "message them on WhatsApp", "reach out via e-mail", "send them an email": a contact verb before it, in the same clause.
    const clause = before.split(/[.;!?\n]/).at(-1) ?? "";
    const byVerb = new RegExp(CONTACT_VERB, "i").test(clause) && /(?:\b(?:via|by|through|over|using|on|in|with|an?)\s+)$/i.test(before);
    // "… via e-mail or WhatsApp", "an email and a LinkedIn invite": joined to a channel already asked for.
    const joined = lastContact >= 0 && joiner.test(words.slice(lastContact, at));
    if (isOnly || asVerb || byVerb || joined) {
      add(only, channel);
      lastContact = at + match[0].length;
    }
  }
  return { only, excluded: excluded.filter((channel) => !only.includes(channel)) };
}

function unique(channels: readonly AudienceChannel[]): AudienceChannel[] {
  return channels.filter((channel, index) => CHANNEL_ORDER.includes(channel) && channels.indexOf(channel) === index);
}

export type ChannelPolicy = {
  /** The channels the plan may use, first choice first. */
  order: AudienceChannel[];
  /** True when the owner's words limited the channels (named some, or ruled some out). */
  restricted: boolean;
  /** Why channels are left out, in the owner's terms ("you asked for WhatsApp"), for the plan's summary and its excluded reasons; null for a general request. */
  note: string | null;
};

export function channelPolicy(input: { requested: readonly AudienceChannel[]; ownerText: string; preferred?: readonly AudienceChannel[]; base?: readonly AudienceChannel[] }): ChannelPolicy {
  const named = ownerChannels(input.ownerText);
  const order = unique([...input.requested, ...(input.base ?? []), ...(input.preferred ?? []), ...CHANNEL_ORDER]);
  if (named.only.length) {
    return { order: order.filter((channel) => named.only.includes(channel)), restricted: true, note: `you asked for ${channelList(named.only)}` };
  }
  if (named.excluded.length) {
    return { order: order.filter((channel) => !named.excluded.includes(channel)), restricted: true, note: `you asked not to use ${channelList(named.excluded)}` };
  }
  return { order, restricted: false, note: null };
}

export function channelList(channels: readonly AudienceChannel[]): string {
  return channels.map((channel) => CHANNEL_NAMES[channel]).join(" or ");
}

/** Why a lead with only these routes gets no channel in a plan: the owner left the route out, or its sender cannot send yet. */
export function unreachableReason(routes: readonly AudienceChannel[], policy: ChannelPolicy, availability: Record<AudienceChannel, { available: boolean; reason: string | null }>): string {
  const unused = routes.filter((channel) => !policy.order.includes(channel));
  const blocked = routes.filter((channel) => policy.order.includes(channel) && !availability[channel].available);
  const unusedText = unused.length ? `${channelList(unused)} ${unused.length > 1 ? "are" : "is"} not used in this run${policy.note ? ` (${policy.note})` : ""}` : null;
  const blockedText = blocked.length ? `${blocked.map((channel) => `${CHANNEL_NAMES[channel]} cannot send yet (${availability[channel].reason ?? "not connected"})`).join("; ")}` : null;
  if (unusedText && !blockedText && unused.length === routes.length) {
    return `reachable only by ${channelList(routes)}, which ${routes.length > 1 ? "are" : "is"} not used in this run${policy.note ? ` (${policy.note})` : ""}`;
  }
  if (blockedText && !unusedText && blocked.length === routes.length && blocked.length === 1) {
    return `reachable only by ${channelList(routes)}, which cannot send yet (${availability[blocked[0]!].reason ?? "not connected"})`;
  }
  return `reachable only by ${channelList(routes)}: ${[unusedText, blockedText].filter(Boolean).join("; ")}`;
}

/**
 * "12 leads (WhatsApp 8, email 4), each on its best ready channel; left
 * out: 22 reachable only by email, …": what a plan uses and the main
 * reasons people were left out, written from the plan rather than by the
 * model, so the chat never claims a narrower or wider plan than it is.
 */
export function planChannelsLine(plan: Pick<OutreachPlan, "assignments" | "excluded" | "channelNote">): string {
  const counts = new Map<AudienceChannel, number>();
  for (const assignment of plan.assignments) counts.set(assignment.channel, (counts.get(assignment.channel) ?? 0) + 1);
  const used = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([channel, count]) => `${CHANNEL_NAMES[channel]} ${count}`).join(", ");
  const scope = plan.channelNote ? `only the channels you named (${plan.channelNote})` : "each on its best ready channel";
  const left = [...plan.excluded].sort((a, b) => b.count - a.count).slice(0, 3).map((item) => `${item.count} ${item.reason}`);
  return `${plan.assignments.length} lead${plan.assignments.length === 1 ? "" : "s"} (${used}), ${scope}${left.length ? `; left out: ${left.join("; ")}` : ""}`;
}
