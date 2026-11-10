"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { FeedManagement, parseFeedManagementTab } from "@/components/feed-management";

function ManageFeedsContent() {
  // `?tab=health` (sidebar "Feed-Zustand"), `?tab=rules`, … open that tab.
  const initialTab = parseFeedManagementTab(useSearchParams().get("tab"));
  return (
    <FeedManagement
      pageMode
      open={true}
      onOpenChange={() => {}}
      initialTab={initialTab}
    />
  );
}

export default function ManageFeedsPage() {
  return (
    <Suspense>
      <ManageFeedsContent />
    </Suspense>
  );
}
