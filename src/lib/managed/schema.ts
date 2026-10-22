import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "@/lib/auth/schema";
import type { ManagedService, PlatformCredentialKey, ServiceMode } from "./catalog";

/**
 * Managed SaaS tables (docs/plans/MANAGED_SAAS_IMPLEMENTATION_2026-10-22.md).
 * Created by scripts/add-managed-saas.ts (db/migrations/20261022-managed-saas.sql).
 */

/**
 * The people who run this AgentSDR instance. GLOBAL: not a role in any
 * organization. Granted only by scripts/grant-platform-operator.ts.
 */
export const platformOperators = pgTable("platform_operators", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  grantedBy: text("granted_by").notNull(),
  note: text("note"),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The platform's own credentials for each Included service, stored by an
 * operator (store.server.ts). GLOBAL: one row per provider, not per
 * organization. The payload is encrypted like every integration credential;
 * `config` holds only non-secret values and masked hints. `fingerprint` is a
 * sha256 of the secret, for comparing keys without decrypting them (never
 * the key).
 */
export const platformCredentials = pgTable(
  "platform_credentials",
  {
    provider: text("provider").primaryKey().$type<PlatformCredentialKey>(),
    encryptedPayload: text("encrypted_payload").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    fingerprint: text("fingerprint").notNull(),
    /** Set when an operator explicitly adopted the credentials from this organization's own. */
    sourceOrganizationId: uuid("source_organization_id").references(() => organizations.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "platform_credentials_provider_chk",
      sql`${table.provider} IN ('unipile', 'openrouter', 'aimlapi', 'anthropic', 'tinyfish', 'tavily', 'brightdata', 'apify')`,
    ),
  ],
);

/** Platform-wide settings an operator chooses, e.g. key 'ai': the Included AI engine and its models. GLOBAL. */
export const platformSettings = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Each organization's explicit choice per service: Included service
 * ('managed') or My own provider ('own'). Scoped. No row: own when the
 * organization has saved credentials for the service, else managed
 * (modes.server.ts). The migration writes 'own' for every organization that
 * had saved credentials, so nothing changes for them on upgrade.
 */
export const providerCredentialModes = pgTable(
  "provider_credential_modes",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    service: text("service").notNull().$type<ManagedService>(),
    mode: text("mode").notNull().$type<ServiceMode>(),
    reason: text("reason"),
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "provider_credential_modes_pkey", columns: [table.organizationId, table.service] }),
    check("provider_credential_modes_service_chk", sql`${table.service} IN ('ai', 'unipile', 'tinyfish', 'tavily', 'brightdata', 'apify')`),
    check("provider_credential_modes_mode_chk", sql`${table.mode} IN ('managed', 'own')`),
  ],
);
