import { NextResponse, type NextRequest } from "next/server";
import { safeFrom } from "@/components/auth/safeFrom";
import { auth } from "@/lib/auth/server";
import { DEMO_DEFAULT_PASSWORD, DEMO_USER_EMAIL, isDemoMode } from "@/lib/demo/mode";

export const dynamic = "force-dynamic";

/**
 * The demo's front door (DEMO_MODE only; 404 otherwise): signs the visitor in
 * as the demo user and sends them on to `from`, or Analytics. Each visitor
 * gets a session of their own, so nobody signs anyone else out. The proxy
 * sends every sign-in screen and every visitor without a session here.
 */
/**
 * The address the visitor used. Behind a reverse proxy (Dokploy's Traefik)
 * the request's own origin is the container's, http://0.0.0.0:3000, so it
 * comes from BETTER_AUTH_URL, else the proxy's forwarded headers.
 */
function publicOrigin(request: NextRequest): string {
  const configured = process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return new URL(configured).origin;
  const host = request.headers.get("x-forwarded-host");
  if (host) return `${request.headers.get("x-forwarded-proto") ?? "https"}://${host}`;
  return request.nextUrl.origin;
}

export async function GET(request: NextRequest) {
  if (!isDemoMode()) return new NextResponse("Not found", { status: 404 });

  const target = new URL(safeFrom(request.nextUrl.searchParams.get("from")) ?? "/assistant", publicOrigin(request));
  // Never loop back into the door itself.
  if (target.pathname === "/demo") target.href = new URL("/assistant", target).href;

  try {
    const { headers } = await auth.api.signInEmail({
      body: { email: DEMO_USER_EMAIL, password: process.env.DEMO_PASSWORD || DEMO_DEFAULT_PASSWORD },
      headers: request.headers,
      returnHeaders: true,
    });
    const response = NextResponse.redirect(target);
    for (const cookie of headers.getSetCookie()) response.headers.append("set-cookie", cookie);
    return response;
  } catch (error) {
    console.error("[demo] could not sign in the demo user — was the database seeded (bun run db:seed:demo)?", error);
    return new NextResponse("The demo is not set up yet: its database has no demo user.", { status: 503 });
  }
}
