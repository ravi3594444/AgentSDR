import "server-only";

import { InstagramSendRefusedError, type DeliverInstagramInput, type DeliverInstagramResult } from "./delivery";

/**
 * Sends one Instagram reply through Unipile. Placeholder until the
 * Instagram sender lands: refuses, so nothing is ever sent by accident.
 */
export async function performInstagramReply(input: DeliverInstagramInput): Promise<DeliverInstagramResult> {
  void input;
  throw new InstagramSendRefusedError("not_connected", "Instagram sending is not available yet.");
}
