"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth/client";
import { AuthShell } from "@/components/auth/AuthShell";
import { ErrorCallout, Field, InfoCallout, SecondaryButton, SubmitButton, linkClass } from "@/components/auth/fields";
import { GoogleButton, OrDivider } from "@/components/auth/GoogleButton";
import { BRAND } from "@/lib/brand";

export function SignUpForm({ googleEnabled, from, inviteOnly = false }: { googleEnabled: boolean; from: string | null; inviteOnly?: boolean }) {
  const target = from || "/analytics";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setLoading(true);
    const { error: err } = await authClient.signUp.email({ name, email, password, callbackURL: target });
    setLoading(false);
    if (err) {
      setError(
        err.code === "USER_ALREADY_EXISTS" || err.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
          ? "An account with this email already exists. Try signing in."
          : err.message || "Something went wrong. Please try again.",
      );
      return;
    }
    setSent(true);
  }

  async function resend() {
    setResending(true);
    setError("");
    const { error: err } = await authClient.sendVerificationEmail({ email, callbackURL: target });
    setResending(false);
    if (err) setError(err.message || "Could not send the email. Please try again.");
    else setResent(true);
  }

  const q = from ? `?from=${encodeURIComponent(from)}` : "";
  const footer = (
    <>
      Already have an account?{" "}
      <Link href={`/sign-in${q}`} className={linkClass}>
        Sign in
      </Link>
    </>
  );

  if (sent) {
    return (
      <AuthShell title="Check your email to confirm your address" subtitle={`We sent a confirmation link to ${email}. Open it to finish creating your account.`} footer={footer}>
        <div className="flex flex-col gap-3">
          {inviteOnly && (
            <InfoCallout>
              This instance is invite-only: if {email} hasn&apos;t been invited, no account was created and no email will arrive.
            </InfoCallout>
          )}
          {error && <ErrorCallout>{error}</ErrorCallout>}
          {resent ? (
            <InfoCallout>Sent again. It can take a minute to arrive.</InfoCallout>
          ) : (
            <SecondaryButton onClick={resend} loading={resending}>
              Resend verification email
            </SecondaryButton>
          )}
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={`Create your ${BRAND.name} account`} footer={footer}>
      {inviteOnly && (
        <div className="mb-5">
          <InfoCallout>This {BRAND.name} workspace is invite-only. Sign up with the email address your invitation was sent to.</InfoCallout>
        </div>
      )}
      <form onSubmit={submit} className="flex flex-col gap-5">
        <Field label="Name" type="text" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
        <Field label="Work email" type="email" autoComplete="email" placeholder="name@company.com" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          hint="At least 8 characters."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <ErrorCallout>{error}</ErrorCallout>}
        <div className="pt-1">
          <SubmitButton loading={loading} loadingLabel="Creating account...">
            Create account
          </SubmitButton>
        </div>
      </form>
      {googleEnabled && (
        <>
          <OrDivider label="Or continue with" />
          <GoogleButton callbackURL={target} onError={setError} label="Google" />
        </>
      )}
    </AuthShell>
  );
}
