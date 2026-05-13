"use client";

import { ServerManagementDialog } from "@/components/server-management-dialog";

export function ServerSettingsClient() {
  return <ServerManagementDialog pageMode open={true} onOpenChange={() => {}} />;
}
