"use client";

import { useState, type FormEvent } from "react";
import { AuthShell } from "@/components/auth/AuthShell";
import { ErrorCallout, Field, SubmitButton } from "@/components/auth/fields";
import { MIN_PASSWORD_LENGTH, validateSetupInput } from "@/lib/auth/setupInput";
import { BRAND } from "@/lib/brand";

export function SetupForm() {
  const [name, setName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    // The organization's time zone starts as the browser's (Settings → Organization changes it).
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const parsed = validateSetupInput({ name, organizationName, email, password, timeZone });
    if (!parsed.ok) return setError(parsed.error);
    setLoading(true);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.value),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; signedIn?: boolean };
      if (res.status === 409) return void window.location.assign("/sign-in");
      if (!res.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        return setLoading(false);
      }
      // If the account was made but the automatic sign-in failed, sign in by hand.
      window.location.assign(data.signedIn ? "/analytics" : "/sign-in");
    } catch {
      setError("Could not reach the server. Please try again.");
      setLoading(false);
    }
  }

  return (
    <AuthShell title={`Set up ${BRAND.name}`} subtitle="Create the first admin account and organization for this instance.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Your name" type="text" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
        <Field label="Organization name" type="text" autoComplete="organization" required value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} />
        <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <ErrorCallout>{error}</ErrorCallout>}
        <SubmitButton loading={loading} loadingLabel="Creating...">
          Create admin account
        </SubmitButton>
      </form>
    </AuthShell>
  );
}
