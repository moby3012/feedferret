"use client";

import { ServerManagementDialog } from "@/components/server-management-dialog";

export function ServerSettingsClient({ initialTab }: { initialTab?: string }) {
  return <ServerManagementDialog pageMode open={true} onOpenChange={() => {}} initialTab={initialTab} />;
}
