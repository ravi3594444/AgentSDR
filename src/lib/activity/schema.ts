import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";

/**
 * How far each person has seen the Replies list (src/lib/activity/): replies
 * recorded after it count as new in the list and the navigation badge. It
 * only moves forward. Seeing a reply
 * approves, answers or changes nothing. Created by scripts/add-activity.ts.
 */
export const activitySeen = pgTable(
  "activity_seen",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id").notNull(),
    repliesSeenAt: timestamp("replies_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ name: "activity_seen_pkey", columns: [table.organizationId, table.userId] })],
);
