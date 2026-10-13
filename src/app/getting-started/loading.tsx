import { PageContainer } from "@/components/page/PageHeader";
import { PageHeaderSkeleton, Skeleton } from "@/components/page/Skeletons";

export default function Loading() {
  return (
    <PageContainer>
      <div aria-busy="true" aria-label="Loading getting started" className="space-y-4">
        <PageHeaderSkeleton />
        {["h-28", "h-72", "h-28", "h-64"].map((height, index) => (
          <Skeleton key={index} className={`${height} rounded-2xl`} />
        ))}
      </div>
    </PageContainer>
  );
}
