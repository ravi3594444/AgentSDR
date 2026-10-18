import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";

/**
 * The organization's research-source settings (src/lib/research/sources/).
 * Today it only records whether Reddit approved this use of its API: the
 * record does not enable reading, since no Reddit reader is built. Created
 * by scripts/add-research-sources.ts; scoped by organization.
 */
export const researchSettings = pgTable("research_settings", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id),
  /** When an owner or admin recorded Reddit's approval; null when it is not recorded. */
  redditApprovalRecordedAt: timestamp("reddit_approval_recorded_at", { withTimezone: true }),
  redditApprovalNote: text("reddit_approval_note"),
  /** The approved Reddit app's client id, last four characters only. */
  redditClientHint: text("reddit_client_hint"),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
