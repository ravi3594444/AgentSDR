"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageContainer, PageHeader } from "@/components/page/PageHeader";
import { ErrorState, LoadingRows } from "@/components/crm/CrmLayout";
import { REQUEST_READ_TIMEOUT_MS } from "./requestRead";

export function RequestsLoading() {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setSlow(true), REQUEST_READ_TIMEOUT_MS); return () => clearTimeout(timer); }, []);
  return <PageContainer><PageHeader title="Requests" description="Loading your saved requests and progress…" />
    {slow ? <ErrorState message="Requests is taking longer than expected. Reload this page to try again." onRetry={() => window.location.reload()} /> : <LoadingRows />}
    <Link href="/assistant" className="mt-4 inline-block underline">Back to Outreach</Link>
  </PageContainer>;
}
