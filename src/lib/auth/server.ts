import "server-only";

import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { authEmail, sendAuthEmail } from "./email";
import { ac, roles } from "./permissions";
import { authSchema, members } from "./schema";
import { mayCreateAccount, mayCreateOrganization } from "./signup";
import { BRAND } from "@/lib/brand";

/**
 * The Better Auth instance: email + password (verified), Google when
 * configured, and organizations with teams. Mounted at /api/auth/[...all].
 *
 * It reuses the app's one Drizzle pool (src/lib/db.ts) — never give it a
 * connection of its own; the database server has 50 slots shared by every
 * deployment.
 *
 * Better Auth authenticates and tracks the active organization; it does not
 * scope our tables. That is src/lib/auth/context.ts and every query after it.
 */

const baseURL = process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL;

const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

/** The organization a fresh session opens in: the one the user joined first. */
async function initialOrganizationId(userId: string): Promise<string | null> {
  const [membership] = await db
    .select({ organizationId: members.organizationId })
    .from(members)
    .where(eq(members.userId, userId))
    .orderBy(asc(members.createdAt))
    .limit(1);
  return membership?.organizationId ?? null;
}

export const auth = betterAuth({
  appName: BRAND.name,
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: baseURL ? [baseURL] : [],
  database: drizzleAdapter(db, { provider: "pg", schema: authSchema, usePlural: true }),
  advanced: {
    database: { generateId: "uuid" },
  },

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    revokeSessionsOnPasswordReset: true,
    // Not awaited: Better Auth's docs warn that waiting on delivery leaks,
    // through response timing, whether an address has an account.
    sendResetPassword: async ({ user, url }) => {
      void sendAuthEmail(
        authEmail({
          to: user.email,
          subject: `Reset your ${BRAND.name} password`,
          intro: `Someone asked to reset the password for this ${BRAND.name} account.`,
          action: "Choose a new password",
          url,
        }),
      ).catch((error) => console.error("[auth] reset email failed:", error));
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      void sendAuthEmail(
        authEmail({
          to: user.email,
          subject: `Confirm your email for ${BRAND.name}`,
          intro: `Welcome to ${BRAND.name}, ${user.name}. Confirm this is your email address to finish creating your account.`,
          action: "Confirm email",
          url,
        }),
      ).catch((error) => console.error("[auth] verification email failed:", error));
    },
  },

  socialProviders: googleConfigured
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          prompt: "select_account",
        },
      }
    : {},

  account: {
    // Signing in with Google as an address that already has a password
    // account joins the two, rather than failing or making a second user.
    accountLinking: { enabled: true, trustedProviders: ["google"] },
  },

  session: {
    // Most requests are answered from a signed cookie instead of a sessions
    // lookup — the connection pool is small. A revoked session or role change
    // can therefore take up to this long to bite.
    cookieCache: { enabled: true, maxAge: 2 * 60 },
  },

  databaseHooks: {
    user: {
      create: {
        // AUTH_SIGNUP=invite-only: no account without a pending invitation
        // (the instance's very first account excepted). Covers Google too.
        before: async (user) => {
          if (!(await mayCreateAccount(user.email))) {
            throw new APIError("FORBIDDEN", {
              message: `Sign-up on this ${BRAND.name} workspace is by invitation only. Ask an admin to invite you.`,
            });
          }
        },
      },
    },
    session: {
      create: {
        before: async (session) => ({
          data: {
            ...session,
            activeOrganizationId: session.activeOrganizationId ?? (await initialOrganizationId(session.userId)),
          },
        }),
      },
    },
  },

  plugins: [
    organization({
      ac,
      roles,
      teams: { enabled: true },
      allowUserToCreateOrganization: (user) => mayCreateOrganization(user.id),
      invitationExpiresIn: 7 * 24 * 60 * 60,
      cancelPendingInvitationsOnReInvite: true,
      sendInvitationEmail: async ({ id, email, organization, inviter }) => {
        void sendAuthEmail(
          authEmail({
            to: email,
            subject: `${inviter.user.name} invited you to ${organization.name} on ${BRAND.name}`,
            intro: `${inviter.user.name} (${inviter.user.email}) invited you to join ${organization.name} on ${BRAND.name}.`,
            action: "Accept invitation",
            url: `${baseURL}/accept-invitation/${id}`,
            outro: "This invitation expires in 7 days. If you weren't expecting it, you can ignore this email.",
          }),
        ).catch((error) => console.error("[auth] invitation email failed:", error));
      },
    }),
    // Must stay last: lets server actions set Better Auth's cookies.
    nextCookies(),
  ],
});

export type AuthSession = typeof auth.$Infer.Session;

/** Whether "Continue with Google" should be offered. */
export const GOOGLE_SIGN_IN_ENABLED = googleConfigured;
