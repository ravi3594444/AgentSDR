/** Recognizes a recipient refusal without inferring WhatsApp registration. */
const RECIPIENT_REFUSAL =
  /recipient[\s_-]*id[\s\S]{0,40}\bvalid\b|corresponding profile is not locked|profile is not locked/i;

export const WHATSAPP_RECIPIENT_REFUSAL =
  "WhatsApp rejected this recipient. Check the number and whether the profile is restricted; WhatsApp registration was not confirmed.";

/** Authentication, throttling, timeouts and server errors are not recipient refusals. */
export function isWhatsappRecipientRefusal(
  status: number | null,
  detail: string | null | undefined,
): boolean {
  return Boolean(
    status &&
      [400, 404, 422].includes(status) &&
      detail?.trim() &&
      RECIPIENT_REFUSAL.test(detail),
  );
}
