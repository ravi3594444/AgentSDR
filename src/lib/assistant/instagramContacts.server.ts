import "server-only";
import { db } from "@/lib/db";
import { upsertInstagramProspect } from "@/lib/instagram/prospects.server";
import { markGivenByOwner } from "./qualify.server";
import { ungroundedInstagramContacts } from "./instagramContacts";
import {
  addAudienceMembers,
  createAudience,
  summarizeAudience,
} from "./audiences.server";

/** Save owner-supplied profiles without provider calls or fabricated email/phone identities. */
export async function createInstagramContactsAudience(input: {
  usernames: string[];
  listName?: string;
  threadId: string;
  userId: string | null;
  requestId?: string | null;
  ownerText?: string;
}) {
  const members = await db.transaction(async (tx) => {
    const found = [];
    for (const username of input.usernames) {
      const profileUrl = `https://www.instagram.com/${username}/`;
      const person = await upsertInstagramProspect(tx, username, {
        source: "assistant chat",
        raw: {
          instagram: { username, profileUrl },
          addedVia: "assistant chat",
        },
      });
      found.push({ personId: person.id, username, profileUrl });
    }
    return found;
  });
  const audienceId = await createAudience({
    name:
      input.listName?.trim().slice(0, 200) ||
      `Instagram contacts: @${members[0]!.username}${members.length > 1 ? ` + ${members.length - 1}` : ""}`,
    source: "list",
    criteria: {
      source: "chat",
      requestId: input.requestId ?? null,
      instagramUsernames: input.usernames,
      preferredChannels: ["instagram"],
    },
    threadId: input.threadId,
    userId: input.userId,
  });
  await addAudienceMembers(
    audienceId,
    members.map((member) => ({
      personId: member.personId,
      source: "list",
      sourceUrl: member.profileUrl,
      evidence: [
        {
          kind: "instagram" as const,
          value: member.username,
          sourceUrl: null,
          source:
            "Provided by the owner in chat; messaging availability not yet verified",
        },
      ],
      matchReason: "The owner selected this Instagram recipient",
    })),
  );
  const notGiven = new Set(ungroundedInstagramContacts(input.usernames, input.ownerText ?? ""));
  await markGivenByOwner(audienceId, members.filter((member) => !notGiven.has(member.username)).map((member) => member.personId), input.requestId ?? null);
  return {
    audienceId,
    audience: await summarizeAudience(audienceId),
    usernames: members.map((member) => member.username),
  };
}
