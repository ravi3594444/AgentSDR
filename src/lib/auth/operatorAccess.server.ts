import "server-only";

import { headers as nextHeaders } from "next/headers";
import { isPlatformOperatorUser } from "./operator.server";
import { auth } from "./server";

/**
 * The gate every platform operator route and page goes through: a signed-in
 * session whose user holds an explicit grant in `platform_operators`. It does
 * not look at organizations at all: an owner or admin of a customer
 * organization (the initial one included) is not an operator unless granted.
 *
 * A caller who is signed in but not an operator gets 404, so the operator
 * routes do not confirm they exist; one who is not signed in gets 401.
 */

export type OperatorContext = { userId: string; userEmail: string; userName: string };

export class OperatorAccessError extends Error {
  constructor(readonly status: 401 | 404) {
    super(status === 401 ? "Sign in to continue" : "Not found");
    this.name = "OperatorAccessError";
  }
}

type HasHeaders = { headers: Headers };

async function resolve(headers: Headers): Promise<OperatorContext> {
  const session = await auth.api.getSession({ headers });
  if (!session) throw new OperatorAccessError(401);
  if (!(await isPlatformOperatorUser(session.user.id))) throw new OperatorAccessError(404);
  return { userId: session.user.id, userEmail: session.user.email, userName: session.user.name };
}

/** The operator making this request; throws OperatorAccessError (401/404). */
export async function requireOperator(request: HasHeaders): Promise<OperatorContext> {
  return resolve(request.headers);
}

/** JSON for an OperatorAccessError, or null for any other error. */
export function operatorErrorResponse(error: unknown): Response | null {
  if (!(error instanceof OperatorAccessError)) return null;
  return Response.json({ error: error.message }, { status: error.status });
}

/**
 * The usual first line of an operator route:
 *   return withOperator(request, async (operator) => Response.json(…));
 * Any other error is answered 500 with a generic message (it may carry a
 * provider's text, which is not sent to the browser) and logged.
 */
export async function withOperator(request: HasHeaders, fn: (operator: OperatorContext) => Promise<Response>): Promise<Response> {
  let operator: OperatorContext;
  try {
    operator = await requireOperator(request);
  } catch (error) {
    const denied = operatorErrorResponse(error);
    if (denied) return denied;
    throw error;
  }
  return fn(operator);
}

/** For the operator pages: the visitor's operator context, or Next's 404 page. */
export async function requirePageOperator(): Promise<OperatorContext> {
  try {
    return await resolve(await nextHeaders());
  } catch (error) {
    if (!(error instanceof OperatorAccessError)) throw error;
    // Imported here for the same reason as in context.ts (next/navigation under react-server tests).
    const { notFound, redirect } = await import("next/navigation");
    if (error.status === 401) return redirect("/sign-in");
    return notFound();
  }
}

/** Whether the visitor is an operator, for showing the panel's link. Never throws for a visitor without a session. */
export async function viewerIsOperator(): Promise<boolean> {
  try {
    await resolve(await nextHeaders());
    return true;
  } catch (error) {
    if (error instanceof OperatorAccessError) return false;
    throw error;
  }
}
