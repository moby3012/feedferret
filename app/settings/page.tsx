import { auth } from "@/auth";
import { db } from "@/lib/db";
import { SettingsForm, type SettingsSection } from "@/components/settings-form";
import { isNewsletterSectionVisible } from "@/lib/newsletter-addresses";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = await searchParams;
  // N1 (spec §10): the Newsletter section stays hidden for non-admins until an
  // admin has connected an inbox; admins see it with "Jetzt einrichten".
  const session = await auth();
  const user = session?.user?.id ? await db.user.findUnique({ where: { id: session.user.id }, select: { role: true } }) : null;
  const hiddenSections: SettingsSection[] = (await isNewsletterSectionVisible(user?.role === "ADMIN").catch(() => false)) ? [] : ["newsletter"];
  // `?tab=reading` (e.g. the gesture hint's "Anpassen") opens that tab.
  return <SettingsForm initialTab={typeof tab === "string" ? tab : undefined} hiddenSections={hiddenSections} />;
}
