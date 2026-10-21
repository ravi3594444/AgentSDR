import { requirePageOrgContext } from "@/lib/auth/context";
import { runInOrganization } from "@/lib/tenancy/scope";
import WorkbookListClient from "@/components/grid/WorkbookListClient";
import { folderPath, listAllFolders, listFolders, resolveFolderId } from "@/lib/grid/folders";
import { listWorkbooks } from "@/lib/grid/workbooks";

export const dynamic = "force-dynamic";

export default async function GridIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string }>;
}) {
  const ctx = await requirePageOrgContext();
  return runInOrganization(ctx.organizationId, async () => {
    const { folder } = await searchParams;

    // A ?folder= pointing at a deleted folder falls back to the root rather
    // than 404ing — the folder may have been removed in another tab.
    const folderId = await resolveFolderId(folder);

    const [folders, workbooks, breadcrumbs, allFolders] = await Promise.all([
      listFolders(folderId),
      listWorkbooks(folderId),
      folderPath(folderId),
      listAllFolders(),
    ]);

    return (
      <div className="workspace-surface flex h-full overflow-hidden bg-bg-white-0">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <WorkbookListClient
            folderId={folderId}
            breadcrumbs={breadcrumbs}
            folders={folders}
            workbooks={workbooks}
            allFolders={allFolders}
          />
        </div>
      </div>
    );
  });
}
