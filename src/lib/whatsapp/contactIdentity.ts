/** A phone-bearing WhatsApp identifier; a privacy id is never interpreted as a phone. */
export function whatsappContactPhone(value: string | null | undefined): string | null {
  const clean = value?.trim().replace(/[\s()-]/g, "") ?? "";
  const match = /^\+?([1-9]\d{7,14})(?::\d+)?(?:@(?:s\.whatsapp\.net|c\.us))?$/.exec(clean);
  return match ? `+${match[1]}` : null;
}

const privacyId = (value: string) => /^\d+(?::\d+)?@lid$/.test(value.trim());
const bare = (value: string) => value.trim().replace(/:\d+(?=@)/, "");

/**
 * A privacy/phone transition needs the same stored account, thread and Person
 * (checked by the caller), plus matching chat and canonical contact phones.
 * Incoming privacy ids must also be the chat's current provider id.
 */
export function sameWhatsappContact(
  previous: string,
  incoming: string,
  proof?: { personPhone: string | null; chatPhone: string | null; chatProviderId: string | null },
): boolean {
  if (previous.trim() === incoming.trim()) return true;
  if (privacyId(previous) && privacyId(incoming) && bare(previous) === bare(incoming)) return true;
  const previousPhone = whatsappContactPhone(previous);
  const incomingPhone = whatsappContactPhone(incoming);
  if (previousPhone && incomingPhone) return previousPhone === incomingPhone;
  if (!proof) return false;
  const phone = whatsappContactPhone(proof.personPhone);
  if (!phone || phone !== whatsappContactPhone(proof.chatPhone)) return false;
  if (privacyId(previous) && incomingPhone === phone) return true;
  return previousPhone === phone && privacyId(incoming)
    && Boolean(proof.chatProviderId && bare(proof.chatProviderId) === bare(incoming));
}
