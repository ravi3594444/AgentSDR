import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { gridProviderCredentials, gridProviders } from "@/lib/grid/schema";

/**
 * Gives a throwaway test organization the AI Settings of an existing one:
 * a copy of its AI connection (credentials still encrypted) and of the
 * settings row pointing at it. For e2e scripts that call the real model.
 */
export async function copyAiSettings(sourceOrganizationId: string, targetOrganizationId: string): Promise<void> {
  const sourceRows = await db.select().from(gridProviders).where(eq(gridProviders.organizationId, sourceOrganizationId));
  const settings = sourceRows.find((row) => row.key === "openrouter-byok-settings");
  const connectionId = (settings?.config as { connectionId?: string } | null)?.connectionId;
  const connection = sourceRows.find((row) => row.id === connectionId);
  const [credential] = connection ? await db.select().from(gridProviderCredentials).where(eq(gridProviderCredentials.providerId, connection.id)) : [];
  if (!settings || !connection || !credential) throw new Error(`Organization ${sourceOrganizationId} has no saved AI Settings with a connection.`);
  const [copy] = await db.insert(gridProviders).values({
    organizationId: targetOrganizationId,
    key: connection.key.replace(/[0-9a-f-]{36}$/, crypto.randomUUID()),
    name: connection.name,
    config: connection.config,
    enabled: connection.enabled,
  }).returning();
  await db.insert(gridProviderCredentials).values({ providerId: copy!.id, encryptedPayload: credential.encryptedPayload });
  await db.insert(gridProviders).values({
    organizationId: targetOrganizationId,
    key: settings.key,
    name: settings.name,
    config: { ...(settings.config as Record<string, unknown>), connectionId: copy!.id },
    enabled: true,
  });
}
