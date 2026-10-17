import { instagramUsername } from "./parse";

export type InstagramRecipient = { username: string; messagingId: string };

/** v1 chat creation requires provider_messaging_id, never the scraped profile id/pk. */
export function instagramRecipient(
  profile: unknown,
  requested: string,
): InstagramRecipient {
  const body = profile as Record<string, unknown> | null;
  const username = instagramUsername(
    body?.username ?? body?.public_identifier,
  )?.toLowerCase();
  if (
    body?.provider !== "INSTAGRAM" ||
    !username ||
    username !== instagramUsername(requested)?.toLowerCase()
  ) {
    throw new Error("Unipile did not confirm the requested Instagram profile");
  }
  const id = body.provider_messaging_id;
  const messagingId =
    typeof id === "string"
      ? id.trim()
      : typeof id === "number" && Number.isSafeInteger(id) && id > 0
        ? String(id)
        : "";
  if (!messagingId)
    throw new Error(
      "Unipile returned no Instagram messaging identifier; no DM was attempted",
    );
  return { username, messagingId };
}

export type InitialDm = {
  id: string;
  username: string;
  text: string;
  unipileAccountId: string;
};
export type InitialDmEffects = {
  resolve: (accountId: string, username: string) => Promise<InstagramRecipient>;
  /** Re-check run/account/DNC/reply gates and reserve the attempt durably before sending. */
  reserve: (recipient: InstagramRecipient) => Promise<boolean>;
  send: (
    accountId: string,
    messagingId: string,
    text: string,
  ) => Promise<{ chatId: string; messageId: string | null }>;
  sent: (
    recipient: InstagramRecipient,
    response: { chatId: string; messageId: string | null },
  ) => Promise<void>;
  failed: (reason: string, uncertain: boolean) => Promise<void>;
};

export function definiteInstagramRefusal(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null)?.status);
  return status >= 400 && status < 500 && status !== 408;
}

/** No retries after crossing the send boundary: a lost response may still mean a delivered DM. */
export async function deliverInitialInstagramDm(
  job: InitialDm,
  effects: InitialDmEffects,
): Promise<void> {
  let attempted = false;
  let recipient: InstagramRecipient;
  let response: Awaited<ReturnType<InitialDmEffects["send"]>>;
  try {
    if (!job.text.trim() || job.text.length > 600 || /\{\{|\}\}/.test(job.text))
      throw new Error(
        "The approved Instagram message is empty, too long, or contains unfilled merge fields",
      );
    recipient = await effects.resolve(job.unipileAccountId, job.username);
    if (!(await effects.reserve(recipient))) return;
    attempted = true;
    response = await effects.send(
      job.unipileAccountId,
      recipient.messagingId,
      job.text,
    );
  } catch (error) {
    await effects.failed(
      error instanceof Error ? error.message : String(error),
      attempted && !definiteInstagramRefusal(error),
    );
    return;
  }
  try {
    await effects.sent(recipient, response);
  } catch (error) {
    await effects.failed(
      error instanceof Error ? error.message : String(error),
      true,
    );
  }
}
