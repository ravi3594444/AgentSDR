import Link from "next/link";
import { Callout } from "@/components/settings/SettingsKit";
import { requirePageOrgContext } from "@/lib/auth/context";
import { MANAGED_SERVICE_INFO, type ManagedService } from "@/lib/managed/catalog";
import { resolveServiceMode } from "@/lib/managed/modes.server";
import { platformCredentialSource } from "@/lib/platform/credentials";
import { runInOrganization } from "@/lib/tenancy/scope";

/**
 * Above a technical settings page (the AI provider, the Unipile connection):
 * while the workspace uses the Included service for it, says so, and that
 * the form below is only for My own provider. Nothing about the platform's
 * own configuration is shown.
 */
export async function ServiceModeNotice({ service }: { service: ManagedService }) {
  const ctx = await requirePageOrgContext();
  const managed = await runInOrganization(ctx.organizationId, async () => (
    service === "unipile" ? (await platformCredentialSource("unipile")) === "managed" : (await resolveServiceMode(service)).mode === "managed"
  ));
  if (!managed) return null;
  return (
    <Callout tone="info" title={`${MANAGED_SERVICE_INFO[service].label}: Included service`}>
      This workspace uses what is included, so nothing needs to be set up here. The settings below are used only if you choose My own provider in{" "}
      <Link className="underline" href="/settings/providers">Advanced → Use your own providers</Link>.
    </Callout>
  );
}
