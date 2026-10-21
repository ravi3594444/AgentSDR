import { sql } from "drizzle-orm";
import { boolean, check, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";
import type { FeatureKey } from "./catalog";

/**
 * Which optional features (catalog.ts) an organization turned on. A missing
 * row means off, so every organization that existed before this table keeps
 * its old behaviour. Created by scripts/add-instagram-intake-discovery.ts.
 */
export const organizationFeatures = pgTable(
  "organization_features",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    key: text("key").notNull().$type<FeatureKey>(),
    enabled: boolean("enabled").notNull().default(false),
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "organization_features_pkey", columns: [table.organizationId, table.key] }),
    check("organization_features_key_chk", sql`${table.key} IN ('instagram', 'web_discovery', 'inquiry_intake', 'apify_discovery', 'treg', 'brightdata')`),
  ],
);

export type OrganizationFeatureRow = typeof organizationFeatures.$inferSelect;
