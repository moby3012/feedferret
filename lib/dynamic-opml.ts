import { db } from "@/lib/db";
import { parseOpml } from "@/lib/opml";
import { applyOpmlImportPlan, planOpmlImport } from "@/lib/import/opml-import";
import { fetchTextWithSsrfProtection, isTrustedFeedFetchingAllowed } from "@/lib/ssrf";
import { logger } from "./logger";

async function fetchSafeOpml(url: string) {
  return fetchTextWithSsrfProtection(
    url,
    {
      headers: { Accept: "text/x-opml,application/xml,text/xml,*/*", "User-Agent": "FeedFerret/1.0" },
    },
    {
      allowInternal: await isTrustedFeedFetchingAllowed(),
      context: "Dynamic OPML fetch",
      maxBytes: 2 * 1024 * 1024,
      maxRedirects: 5,
      timeoutMs: 15_000,
    },
  );
}

export async function syncDynamicOpmlCategories(userId?: string) {
  const categories = await db.category.findMany({
    where: { opmlUrl: { not: null }, ...(userId ? { userId } : {}) },
    select: { id: true, userId: true, opmlUrl: true, name: true },
  });

  const results = [];
  const concurrency = 4;

  for (let i = 0; i < categories.length; i += concurrency) {
    const batch = categories.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (category) => {
        if (!category.opmlUrl) return null;
        try {
          const xml = await fetchSafeOpml(category.opmlUrl);
          const outlines = await parseOpml(xml);
          // Remote OPML is third-party controlled: same mapping as a local import, but
          // cookies/headers/proxy/POST options, nested dynamic categories and auto-read
          // rules are not accepted (see `trust: "remote"` in lib/import/opml-import).
          const plan = planOpmlImport(outlines, { trust: "remote" });
          const report = await applyOpmlImportPlan(category.userId, plan, { parentCategoryId: category.id });
          for (const error of report.errors) logger.warn(`[dynamic-opml] ${category.name}: ${error}`);
          return { category: category.name, success: true, count: outlines.length };
        } catch (error) {
          logger.error(`[dynamic-opml] failed for ${category.opmlUrl}:`, error);
          return { category: category.name, success: false, error: String(error) };
        }
      }),
    );
    for (const result of batchResults) {
      if (result) results.push(result);
    }
  }
  return results;
}
