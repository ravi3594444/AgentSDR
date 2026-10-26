"use client";

import Link from "next/link";
import { PageContainer, PageHeader } from "@/components/page/PageHeader";
import { ErrorState } from "@/components/crm/CrmLayout";

export default function RequestsError({ reset }: { reset: () => void }) {
  return <PageContainer><PageHeader title="Requests" description="Your saved requests could not be loaded." />
    <ErrorState message="Try loading Requests again. This does not restart research or send messages." onRetry={reset} />
    <Link href="/assistant" className="mt-4 inline-block underline">Back to Outreach</Link>
  </PageContainer>;
}
