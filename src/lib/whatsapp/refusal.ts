/**
 * WhatsApp's own refusal of a recipient, as it reaches us through Unipile.
 *
 * A 4xx from Unipile means nothing was sent. Within that, WhatsApp uses one
 * error for "this number cannot receive a message": no WhatsApp account on
 * the number (a landline, a switchboard, a wrong digit) or a profile that is
 * locked. Unipile relays it as
 *
 *   "Make sure that the recipient ID is valid and that the corresponding
 *    profile is not locked."
 *
 * That is a fact about the recipient, not a bug in the send: the lead is
 * marked failed, never retried, and the Results page should say what
 * happened without the platform's generic wording.
 */
const NOT_ON_WHATSAPP =
  /recipient[\s_-]*id[\s\S]{0,40}\bvalid\b|corresponding profile is not locked|profile is not locked/i;

export function isRecipientNotOnWhatsapp(detail: string | null | undefined): boolean {
  const text = detail?.trim();
  return Boolean(text && NOT_ON_WHATSAPP.test(text));
}
