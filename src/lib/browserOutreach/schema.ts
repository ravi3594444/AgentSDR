import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "@/lib/auth/schema";
import { people } from "@/lib/leads/schema";
import { outreachRuns } from "@/lib/assistant/schema";
import type { MessagingSite } from "./routes";

/**
 * Browser outreach (src/lib/browserOutreach/): messages delivered through the
 * owner's own signed-in Chrome on X, Instagram, Facebook and LinkedIn.
 * Created by scripts/add-browser-outreach.ts
 * (db/migrations/20261030-browser-outreach.sql).
 */

export type RouteState = "unverified" | "messageable" | "not_messageable" | "not_found";

/** A person's profile on a messaging site, and what the owner's browser found there when it last looked. */
export const browserContactRoutes = pgTable(
  "browser_contact_routes",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    site: text("site").notNull().$type<MessagingSite>(),
    handle: text("handle").notNull(),
    profileUrl: text("profile_url").notNull(),
    state: text("state").notNull().$type<RouteState>().default("unverified"),
    detail: text("detail"),
    sourceUrl: text("source_url"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    /** The direct-message conversation's address, once one exists: read for replies. */
    threadUrl: text("thread_url"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("browser_contact_routes_org_site_handle_uq").on(table.organizationId, table.site, table.handle),
    index("browser_contact_routes_org_person_idx").on(table.organizationId, table.personId),
    index("browser_contact_routes_sync_idx").on(table.organizationId, table.syncedAt).where(sql`${table.threadUrl} IS NOT NULL`),
    check("browser_contact_routes_site_chk", sql`${table.site} IN ('x', 'instagram', 'facebook', 'linkedin')`),
    check("browser_contact_routes_state_chk", sql`${table.state} IN ('unverified', 'messageable', 'not_messageable', 'not_found')`),
  ],
);

/** The account a person's browser is signed in as on a site, as its pages showed it: later sends must come from it. */
export const browserSenderAccounts = pgTable(
  "browser_sender_accounts",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    site: text("site").notNull().$type<MessagingSite>(),
    handle: text("handle").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId, table.site] }),
    check("browser_sender_accounts_site_chk", sql`${table.site} IN ('x', 'instagram', 'facebook', 'linkedin')`),
  ],
);

export type BrowserSendStatus = "queued" | "waiting" | "sending" | "sent" | "failed" | "uncertain" | "blocked" | "cancelled";
export type CourierLogEntry = { at: string; step: string; ok: boolean; detail: string };

/**
 * One message to deliver through the owner's browser: a step of an approved
 * run, or a reply. The row is the claim that keeps it from being sent twice;
 * one whose answer was lost stays "uncertain" and is never resent.
 */
export const browserOutreachSends = pgTable(
  "browser_outreach_sends",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").references(() => outreachRuns.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    routeId: uuid("route_id").notNull().references(() => browserContactRoutes.id, { onDelete: "cascade" }),
    /** Whose connected browser sends it: the run's approver, or the reply's sender. */
    userId: uuid("user_id").notNull().references(() => users.id),
    kind: text("kind").notNull().$type<"step" | "reply">().default("step"),
    step: integer("step").notNull().default(0),
    body: text("body").notNull(),
    draftId: uuid("draft_id"),
    status: text("status").notNull().$type<BrowserSendStatus>().default("queued"),
    /** Why it is not sending yet, said plainly, and when it is looked at again. */
    waitReason: text("wait_reason"),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text("locked_by"),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    senderHandle: text("sender_handle"),
    threadUrl: text("thread_url"),
    log: jsonb("log").$type<CourierLogEntry[]>().notNull().default([]),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("browser_outreach_sends_run_person_step_uq").on(table.runId, table.personId, table.step).where(sql`${table.kind} = 'step'`),
    uniqueIndex("browser_outreach_sends_draft_uq").on(table.draftId).where(sql`${table.kind} = 'reply'`),
    index("browser_outreach_sends_due_idx").on(table.organizationId, table.status, table.dueAt),
    index("browser_outreach_sends_attempted_idx").on(table.organizationId, table.userId, table.attemptedAt),
    check("browser_outreach_sends_kind_chk", sql`${table.kind} IN ('step', 'reply')`),
    check("browser_outreach_sends_status_chk", sql`${table.status} IN ('queued', 'waiting', 'sending', 'sent', 'failed', 'uncertain', 'blocked', 'cancelled')`),
    check("browser_outreach_sends_step_chk", sql`(${table.kind} = 'step' AND ${table.runId} IS NOT NULL) OR (${table.kind} = 'reply' AND ${table.draftId} IS NOT NULL)`),
  ],
);
