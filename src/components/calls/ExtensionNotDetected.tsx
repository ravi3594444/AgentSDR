"use client";

import { DocsLink } from "@/components/page/DocsLink";
import { extensionNotDetected } from "@/lib/calls/recorderRelease";
import { cn } from "@/utils/cn";

/**
 * Shown where the extension's mark is missing from this page. Installed but
 * without access to this address (a self-hosted deployment) looks exactly like
 * not installed, so this never claims it is missing: it says how to give it
 * this site, then how to install it. Client-only (reads this page's address).
 */
export function ExtensionNotDetected({ install, className }: { install?: React.ReactNode; className?: string }) {
  const help = extensionNotDetected(window.location.origin);
  return (
    <div className={cn("space-y-1.5 text-paragraph-xs text-text-sub-600", className)}>
      <p className="text-label-sm text-text-strong-950">{help.title}</p>
      <p>{help.intro}</p>
      <ol className="list-decimal space-y-0.5 pl-4">
        {help.steps.map((step) => <li key={step}>{step}</li>)}
      </ol>
      {install && <p>{install}</p>}
      {!help.builtIn && <DocsLink page="whatsapp/calling#self-hosted-agentsdr" appearance="inline">Self-hosted setup</DocsLink>}
    </div>
  );
}
