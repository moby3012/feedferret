"use client";

import { Suspense } from "react";
import { FeedManagement } from "@/components/feed-management";

function ManageFeedsContent() {
  return (
    <FeedManagement
      pageMode
      open={true}
      onOpenChange={() => {}}
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
