"use client";

import { use, useEffect, useState } from "react";
import { authClient, useSession } from "@/lib/auth/client";
import { AuthShell } from "@/components/auth/AuthShell";
import { ErrorCallout, SecondaryButton, linkClass } from "@/components/auth/fields";
import { Spinner } from "@/components/auth/fields";
import Link from "next/link";
import { BRAND } from "@/lib/brand";

type Invitation = {
  id: string;
  organizationName: string;
  inviterEmail: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date | string;
  organizationId: string;
};

export default function AcceptInvitationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: session, isPending } = useSession();
  const [invite, setInvite] = useState<Invitation | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "wrong-email">("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [declined, setDeclined] = useState(false);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (isPending) return;
    let cancelled = false;
    authClient.organization.getInvitation({ query: { id } }).then(({ data, error: err }) => {
      if (cancelled) return;
      if (err || !data) {
        // Signed out, a stranger's invitation, or gone: the API answers the same for all.
        setState(session ? (err?.status === 403 ? "wrong-email" : "missing") : "ready");
        return;
      }
      const inv = data as Invitation;
      setInvite(inv);
      setExpired(inv.status !== "pending" || new Date(inv.expiresAt).getTime() < Date.now());
      setState("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [id, isPending, session]);

  const from = encodeURIComponent(`/accept-invitation/${id}`);

  async function accept() {
    setError("");
    setBusy("accept");
    const res = await authClient.organization.acceptInvitation({ invitationId: id });
    if (res.error) {
      setError(res.error.message || "Could not accept the invitation.");
      return setBusy(null);
    }
    const organizationId = res.data?.invitation?.organizationId ?? invite?.organizationId;
    if (organizationId) {
      const active = await authClient.organization.setActive({ organizationId });
      if (active.error) {
        setError(active.error.message || "Joined, but could not switch into the organization.");
        return setBusy(null);
      }
    }
    window.location.href = "/assistant";
  }

  async function decline() {
    setError("");
    setBusy("decline");
    const { error: err } = await authClient.organization.rejectInvitation({ invitationId: id });
    setBusy(null);
    if (err) setError(err.message || "Could not decline the invitation.");
    else setDeclined(true);
  }

  if (state === "loading" || isPending) {
    return (
      <AuthShell title="Loading invitation">
        <div className="flex justify-center text-slate-400">
          <Spinner />
        </div>
      </AuthShell>
    );
  }

  if (declined) {
    return (
      <AuthShell title="Invitation declined" subtitle="You won't be added to this organization.">
        <Link href="/" className={linkClass}>
          Go to {BRAND.name}
        </Link>
      </AuthShell>
    );
  }

  if (state === "wrong-email") {
    return (
      <AuthShell title="Wrong account" subtitle="This invitation was sent to a different email address. Sign in with the invited address to accept it.">
        <Link href={`/sign-in?from=${from}`} className={linkClass}>
          Switch account
        </Link>
      </AuthShell>
    );
  }

  if (state === "missing" || expired) {
    return (
      <AuthShell
        title={expired ? "Invitation expired" : "Invitation not found"}
        subtitle={expired ? "This invitation is no longer valid. Ask the person who invited you to send a new one." : "This link is invalid, was already used, or was sent to a different email address."}
      >
        <Link href="/sign-in" className={linkClass}>
          Back to sign in
        </Link>
      </AuthShell>
    );
  }

  const who = invite ? `${invite.inviterEmail} invited you to join ${invite.organizationName}.` : "You've been invited to join an organization.";

  if (!session) {
    return (
      <AuthShell title="You're invited" subtitle={`${who} Sign in or create an account to accept.`}>
        <div className="flex flex-col gap-3">
          <Link href={`/sign-in?from=${from}`} className="w-full rounded-lg bg-indigo-600 py-3 text-center text-sm font-medium text-white transition-colors hover:bg-indigo-500">
            Sign in to accept
          </Link>
          <Link href={`/sign-up?from=${from}`} className="w-full rounded-lg border border-slate-700 bg-slate-800 py-3 text-center text-sm font-medium text-white transition-colors hover:bg-slate-700">
            Create account
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="You're invited" subtitle={who}>
      <div className="flex flex-col gap-3">
        {error && <ErrorCallout>{error}</ErrorCallout>}
        <button
          type="button"
          onClick={accept}
          disabled={!!busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 py-3 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === "accept" && <Spinner />}
          Accept
        </button>
        <SecondaryButton onClick={decline} loading={busy === "decline"} disabled={!!busy}>
          Decline
        </SecondaryButton>
      </div>
    </AuthShell>
  );
}
