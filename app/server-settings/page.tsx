import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { ServerSettingsClient } from "./client";

export default async function ServerSettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const session = await auth();

  if (!session?.user || (session.user as any).role !== "ADMIN") {
    redirect("/");
  }

  const { tab } = await searchParams;
  return <ServerSettingsClient initialTab={typeof tab === "string" ? tab : undefined} />;
}
