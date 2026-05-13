import { FeedManagement } from "@/components/feed-management";

export default function ManageFeedsPage() {
  return (
    <FeedManagement
      pageMode
      open={true}
      onOpenChange={() => {}}
    />
  );
}
