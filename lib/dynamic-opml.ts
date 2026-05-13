import { db } from "@/lib/db";
import { httpOptionsFromOutline, OpmlOutline, parseOpml, scraperConfigFromOutline } from "@/lib/opml";
import { normalizeSourceType, stringifyNonEmpty } from "@/lib/feed-extraction";
import { fetchTextWithSsrfProtection, isTrustedFeedFetchingAllowed } from "@/lib/ssrf";

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

function feedDataFromOutline(outline: OpmlOutline, userId: string, categoryId: string) {
  const extensions = outline.extensions ?? {};
  const scraperConfig = scraperConfigFromOutline(outline);
  const httpOptions = httpOptionsFromOutline(outline);
  return {
    userId,
    url: outline.xmlUrl!,
    name: outline.text,
    categoryId,
    sourceType: normalizeSourceType(outline.type),
    htmlUrl: outline.htmlUrl || null,
    description: outline.description || null,
    priority: extensions.priority || "main",
    unicityCriteria: extensions.unicityCriteria || "id",
    unicityCriteriaForced: extensions.unicityCriteriaForced === "true" || extensions.unicityCriteriaForced === "1",
    scraperConfig: stringifyNonEmpty(scraperConfig),
    httpOptions: stringifyNonEmpty(httpOptions),
    fullTextSelector: extensions.cssFullContent || null,
    fullTextConditions: extensions.cssFullContentConditions || null,
    fullTextRemoveSelectors: extensions.cssContentFilter || extensions.cssFullContentFilter || null,
    filtersActionRead: extensions.filtersActionRead || null,
    customUserAgent: typeof httpOptions.CURLOPT_USERAGENT === "string" ? httpOptions.CURLOPT_USERAGENT : undefined,
  };
}

async function importDynamicOutline(userId: string, outline: OpmlOutline, parentCategoryId: string) {
  if (outline.xmlUrl) {
    const data = feedDataFromOutline(outline, userId, parentCategoryId);
    await db.feed.upsert({
      where: { userId_url: { userId, url: data.url } },
      update: {
        name: data.name,
        categoryId: parentCategoryId,
        sourceType: data.sourceType,
        htmlUrl: data.htmlUrl,
        description: data.description,
        priority: data.priority,
        unicityCriteria: data.unicityCriteria,
        unicityCriteriaForced: data.unicityCriteriaForced,
        scraperConfig: data.scraperConfig,
        httpOptions: data.httpOptions,
        fullTextSelector: data.fullTextSelector,
        fullTextConditions: data.fullTextConditions,
        fullTextRemoveSelectors: data.fullTextRemoveSelectors,
        filtersActionRead: data.filtersActionRead,
        ...(data.customUserAgent ? { customUserAgent: data.customUserAgent } : {}),
      },
      create: data,
    });
    return;
  }

  if (!outline.children?.length) return;
  const category = await db.category.upsert({
    where: { userId_name_parentId: { userId, name: outline.text, parentId: parentCategoryId } },
    update: { opmlUrl: outline.extensions?.opmlUrl ?? undefined },
    create: { userId, name: outline.text, parentId: parentCategoryId, opmlUrl: outline.extensions?.opmlUrl ?? undefined },
  });
  for (const child of outline.children) await importDynamicOutline(userId, child, category.id);
}

export async function syncDynamicOpmlCategories(userId?: string) {
  const categories = await db.category.findMany({
    where: { opmlUrl: { not: null }, ...(userId ? { userId } : {}) },
    select: { id: true, userId: true, opmlUrl: true, name: true },
  });

  const results = [];
  for (const category of categories) {
    if (!category.opmlUrl) continue;
    try {
      const xml = await fetchSafeOpml(category.opmlUrl);
      const outlines = await parseOpml(xml);
      for (const outline of outlines) await importDynamicOutline(category.userId, outline, category.id);
      results.push({ category: category.name, success: true, count: outlines.length });
    } catch (error) {
      console.error(`[dynamic-opml] failed for ${category.opmlUrl}:`, error);
      results.push({ category: category.name, success: false, error: String(error) });
    }
  }
  return results;
}
