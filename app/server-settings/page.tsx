import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { ServerSettingsClient } from "./client";

export default async function ServerSettingsPage() {
  const session = await auth();

  if (!session?.user || (session.user as any).role !== "ADMIN") {
    redirect("/");
  }

  return <ServerSettingsClient />;
}
