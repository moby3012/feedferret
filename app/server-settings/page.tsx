import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { ServerManagementDialog } from "@/components/server-management-dialog";

export default async function ServerSettingsPage() {
  const session = await auth();

  if (!session?.user || (session.user as any).role !== "ADMIN") {
    redirect("/");
  }

  return (
    <ServerManagementDialog
      pageMode
      open={true}
      onOpenChange={() => {}}
    />
  );
}
