import { db } from "@/lib/db";
import { normalizeCategoryNameFromTag } from "@/lib/greader";

/** One wire namespace: a folder wins the type; rename/delete affect both namesakes.
 * Renaming onto any existing name is rejected rather than silently merging data. */
export async function manageGReaderTag(userId: string, form: FormData, rename: boolean) {
  const names = [...new Set(form.getAll("s").map(String).map(normalizeCategoryNameFromTag))];
  const destination = rename ? normalizeCategoryNameFromTag(String(form.get("dest") || "")) : null;
  if (!names.length || names.length > 100 || names.some((n) => !n) || (rename && (!destination || names.length !== 1))) return new Response("Invalid label", { status: 400 });
  return db.$transaction(async (tx) => {
    if (rename && destination !== names[0] && (
      await tx.category.count({ where: { userId, name: destination! } }) ||
      await tx.label.count({ where: { userId, name: destination! } })
    )) return new Response("Destination already exists", { status: 409 });
    for (const name of names as string[]) {
      if (rename) {
        await tx.category.updateMany({ where: { userId, name }, data: { name: destination! } });
        await tx.label.updateMany({ where: { userId, name }, data: { name: destination! } });
        await tx.gReaderPreference.updateMany({ where: { userId, streamId: `user/-/label/${name}` }, data: { streamId: `user/-/label/${destination}` } });
      } else {
        const categories = await tx.category.findMany({ where: { userId, name }, select: { id: true } });
        const ids = categories.map((c) => c.id);
        await tx.feed.updateMany({ where: { userId, categoryId: { in: ids } }, data: { categoryId: null } });
        await tx.category.updateMany({ where: { userId, parentId: { in: ids } }, data: { parentId: null } });
        await tx.category.deleteMany({ where: { userId, name } });
        await tx.label.deleteMany({ where: { userId, name } });
        await tx.gReaderPreference.deleteMany({ where: { userId, streamId: `user/-/label/${name}` } });
      }
    }
    return new Response("OK");
  });
}

