import { SettingsForm } from "@/components/settings-form";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = await searchParams;
  // `?tab=reading` (e.g. the gesture hint's "Anpassen") opens that tab.
  return <SettingsForm initialTab={typeof tab === "string" ? tab : undefined} />;
}
