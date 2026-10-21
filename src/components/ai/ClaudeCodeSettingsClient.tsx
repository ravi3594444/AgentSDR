"use client";

import { useCallback, useEffect, useState } from "react";
import { RiExternalLinkLine, RiLoader4Line } from "@remixicon/react";
import { StepFrame } from "@/components/ai/ByokSettingsClient";
import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import * as Select from "@/components/alignui/select";
import { FormSkeleton } from "@/components/settings/SettingsSkeletons";
import { Callout, Field } from "@/components/settings/SettingsKit";
import {
  CLAUDE_CODE_LOGIN_METHODS,
  CLAUDE_CODE_MODELS,
  type ClaudeCodeLoginMethod,
  type ClaudeCodeModel,
  type ClaudeCodeSignIn,
  type ClaudeCodeStatus,
} from "@/lib/ai/claudeCode/contract";

const ENDPOINT = "/api/ai/claude-code";

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? "Something went wrong. Please try again.");
  return body as T;
}

function post<T>(body: Record<string, unknown>): Promise<T> {
  return fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((response) => readJson<T>(response));
}

const WINDOW_LABELS: Record<string, string> = { five_hour: "5-hour window", seven_day: "Weekly", seven_day_opus: "Weekly (Opus)", seven_day_sonnet: "Weekly (Sonnet)" };

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "not reported";
}

/**
 * Settings → AI provider → Claude Code: sign this server's Claude Code CLI in
 * with your own Claude account (the CLI's own sign-in; the code Anthropic
 * shows goes straight to it), check which models your account can use, and
 * choose whether this organization's AI steps run on it. Owner-only pilot.
 */
export default function ClaudeCodeSettingsClient({ onChanged }: { onChanged?: () => void }) {
  const [status, setStatus] = useState<ClaudeCodeStatus | null>(null);
  const [signIn, setSignIn] = useState<ClaudeCodeSignIn | null>(null);
  const [method, setMethod] = useState<ClaudeCodeLoginMethod>("claudeai");
  const [model, setModel] = useState<ClaudeCodeModel>("default");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((next: ClaudeCodeStatus) => {
    setStatus(next);
    setSignIn(next.signIn);
    setModel(next.engine.ownedByYou ? next.engine.model : "default");
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await readJson<ClaudeCodeStatus>(await fetch(ENDPOINT, { cache: "no-store" })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [apply]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  // While a sign-in waits for the code, follow it without starting the CLI again.
  const waitingFlow = signIn?.phase === "waiting" ? signIn.flowId : null;
  useEffect(() => {
    if (!waitingFlow) return;
    const timer = window.setInterval(() => {
      void fetch(`${ENDPOINT}?flow=${encodeURIComponent(waitingFlow)}`, { cache: "no-store" })
        .then((response) => readJson<{ signIn: ClaudeCodeSignIn }>(response))
        .then(({ signIn: next }) => {
          if (next.phase === "waiting") return;
          setSignIn(next);
          void load();
        })
        .catch(() => { void load(); });
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [waitingFlow, load]);

  async function act(name: string, body: Record<string, unknown>) {
    setBusy(name);
    setError(null);
    try {
      const result = await post<ClaudeCodeStatus | { signIn: ClaudeCodeSignIn; status?: ClaudeCodeStatus }>(body);
      if ("allowed" in result) apply(result);
      else {
        setSignIn(result.signIn);
        if (result.status) apply(result.status);
        if (result.signIn.phase !== "waiting") void load();
      }
      if (name === "use" || name === "stop_using") onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  if (!status) return error ? <Callout tone="error">{error}</Callout> : <FormSkeleton frames={3} />;
  if (!status.allowed) return <Callout tone="info" title="Claude Code is not available here">{status.reason}</Callout>;

  const signedIn = status.account.signedIn === true;
  const engine = status.engine;
  const check = engine.checks[model];
  const usingMine = engine.selected && engine.ownedByYou;

  return (
    <div className="space-y-4">
      <Callout tone="info">
        Runs Anthropic&apos;s own Claude Code program on this server, signed in with your own Claude account. Your organization&apos;s AI steps (the assistant, lead judging, outreach writing, reply sorting, drafts and the reply agent) then use your account&apos;s usage limits instead of an API key. Nothing switches to a paid API when your limit is reached or you are signed out: those steps wait or fail with the reason. Table AI columns saved for an API model, AI web search and call transcription keep using the API provider above.
      </Callout>
      {error && <Callout tone="error">{error}</Callout>}

      <StepFrame step={1} done={Boolean(status.cli)} title="Claude Code on this server" description="The unmodified Claude Code CLI, installed with the server image.">
        {status.cli
          ? <p className="text-paragraph-sm text-text-sub-600">Claude Code {status.cli.version} is installed.</p>
          : <Callout tone="warning">{status.cliError}</Callout>}
      </StepFrame>

      <StepFrame
        step={2}
        done={signedIn}
        title="Sign in with your own account"
        description="Claude Code's own sign-in opens on Anthropic's site. After you sign in there, Anthropic shows a code: paste it here and it goes straight to Claude Code on this server. It is not stored."
        actions={signedIn ? (
          <Button.Root type="button" variant="neutral" mode="stroke" size="small" disabled={busy !== null || usingMine} onClick={() => void act("sign_out", { action: "sign_out" })} title={usingMine ? "Stop using Claude Code for AI steps first" : undefined}>
            {busy === "sign_out" && <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />}Sign out
          </Button.Root>
        ) : undefined}
      >
        {signedIn ? (
          <p className="text-paragraph-sm text-text-sub-600">Signed in{status.account.method ? ` (${status.account.method})` : ""}. Only this organization&apos;s work uses this login, and only while you are an owner here.</p>
        ) : signIn?.phase === "waiting" && signIn.authorizationUrl ? (
          <div className="max-w-xl space-y-3">
            <a href={signIn.authorizationUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-label-sm text-primary-base underline underline-offset-2">
              Open Anthropic&apos;s sign-in page<RiExternalLinkLine className="size-4" aria-hidden="true" />
            </a>
            <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(event) => { event.preventDefault(); const pasted = code; setCode(""); void act("submit_code", { action: "submit_code", flowId: signIn.flowId, code: pasted }); }}>
              <Field label="Code from Anthropic's page" htmlFor="claude-code-login-code" className="flex-1">
                <Input.Root size="small">
                  <Input.Wrapper>
                    <Input.Input id="claude-code-login-code" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste the code" />
                  </Input.Wrapper>
                </Input.Root>
              </Field>
              <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={busy !== null || !code.trim()}>
                {busy === "submit_code" && <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />}Finish sign-in
              </Button.Root>
              <Button.Root type="button" variant="neutral" mode="stroke" size="small" disabled={busy !== null} onClick={() => void act("cancel", { action: "cancel" })}>Cancel</Button.Root>
            </form>
            {signIn.expiresAt && <p className="text-paragraph-xs text-text-soft-400">This link works until {when(signIn.expiresAt)}.</p>}
          </div>
        ) : (
          <div className="flex max-w-xl flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="Account" className="flex-1" description={CLAUDE_CODE_LOGIN_METHODS.find((entry) => entry.key === method)?.detail}>
              <Select.Root size="small" value={method} onValueChange={(value) => setMethod(value as ClaudeCodeLoginMethod)} disabled={!status.cli}>
                <Select.Trigger aria-label="Account"><Select.Value /></Select.Trigger>
                <Select.Content>
                  {CLAUDE_CODE_LOGIN_METHODS.map((entry) => <Select.Item key={entry.key} value={entry.key}>{entry.label}</Select.Item>)}
                </Select.Content>
              </Select.Root>
            </Field>
            <Button.Root type="button" variant="primary" mode="filled" size="small" disabled={busy !== null || !status.cli} onClick={() => void act("sign_in", { action: "sign_in", method })}>
              {busy === "sign_in" && <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />}{engine.ownedByYou ? "Sign in again" : "Sign in"}
            </Button.Root>
          </div>
        )}
        {signIn && signIn.phase !== "waiting" && signIn.phase !== "succeeded" && signIn.message && <Callout tone="warning" className="mt-3 max-w-xl">{signIn.message}</Callout>}
        {engine.selected && engine.ownedByYou && !signedIn && <Callout tone="error" className="mt-3 max-w-xl">Your Claude login answers this organization&apos;s AI steps, and it is signed out. Those steps fail until you sign in again.</Callout>}
      </StepFrame>

      <StepFrame
        step={3}
        done={usingMine}
        title="Use it for this organization's AI steps"
        description="Check a model first: it sends one short request on your account and shows the model Claude Code actually ran."
      >
        <div className="flex max-w-xl flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="Model" className="flex-1">
            <Select.Root size="small" value={model} onValueChange={(value) => setModel(value as ClaudeCodeModel)} disabled={!signedIn}>
              <Select.Trigger aria-label="Model"><Select.Value /></Select.Trigger>
              <Select.Content>
                {CLAUDE_CODE_MODELS.map((entry) => <Select.Item key={entry.key} value={entry.key}>{entry.label}</Select.Item>)}
              </Select.Content>
            </Select.Root>
          </Field>
          <Button.Root type="button" variant="neutral" mode="stroke" size="small" disabled={busy !== null || !signedIn} onClick={() => void act("check_model", { action: "check_model", model })}>
            {busy === "check_model" && <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />}Check
          </Button.Root>
          {usingMine
            ? <Button.Root type="button" variant="neutral" mode="stroke" size="small" disabled={busy !== null} onClick={() => void act("stop_using", { action: "stop_using" })}>Stop using</Button.Root>
            : <Button.Root type="button" variant="primary" mode="filled" size="small" disabled={busy !== null || !signedIn || !check?.ok} onClick={() => void act("use", { action: "use", model })}>Use Claude Code</Button.Root>}
        </div>
        {check && (check.ok
          ? <p className="mt-2 text-paragraph-xs text-text-sub-600">Checked {when(check.checkedAt)}: answered as {check.modelId}.</p>
          : <Callout tone="warning" className="mt-3 max-w-xl">Checked {when(check.checkedAt)}: {check.error}</Callout>)}
        {engine.selected && !engine.ownedByYou && <Callout tone="info" className="mt-3 max-w-xl">This organization&apos;s AI steps use another owner&apos;s Claude login. Using yours switches them to your account.</Callout>}
        {usingMine && <Callout tone="success" className="mt-3 max-w-xl">This organization&apos;s AI steps run on your Claude account ({CLAUDE_CODE_MODELS.find((entry) => entry.key === engine.model)?.label}). Stop using it to return them to the API provider above.</Callout>}
      </StepFrame>

      {(status.running > 0 || status.limit || status.windows.length > 0) && (
        <StepFrame step={4} done={!status.limit} title="Usage" description="Only what Claude Code itself reported; nothing here is estimated.">
          <div className="max-w-xl space-y-2 text-paragraph-sm text-text-sub-600">
            {status.running > 0 && <p>{status.running} AI {status.running === 1 ? "step is" : "steps are"} running on this login now.</p>}
            {status.limit && <Callout tone="warning">{status.limit.message}</Callout>}
            {status.windows.length > 0 && (
              <ul className="space-y-1">
                {status.windows.map((window) => (
                  <li key={window.window}>
                    {WINDOW_LABELS[window.window] ?? window.window}: {window.utilization === null ? "use not reported" : `${Math.round(window.utilization * 100)}% used`}, resets {when(window.resetsAt)}
                  </li>
                ))}
              </ul>
            )}
            {status.windowsReportedAt && <p className="text-paragraph-xs text-text-soft-400">As reported by Claude Code at {when(status.windowsReportedAt)}.</p>}
          </div>
        </StepFrame>
      )}
    </div>
  );
}
