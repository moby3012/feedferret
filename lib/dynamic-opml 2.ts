import dns from "dns/promises";
import net from "net";
import { db } from "@/lib/db";
import { httpOptionsFromOutline, OpmlOutline, parseOpml, scraperConfigFromOutline } from "@/lib/opml";
import { normalizeSourceType, stringifyNonEmpty } from "@/lib/freshrss-opml";

function isPrivateIp(ip: string) {
  const version = net.isIP(ip);
  if (version === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0
    );
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
  }
  return true;
}

async function assertSafeUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Dynamic OPML only supports http/https URLs");

  if (net.isIP(url.hostname)) {
    if (isPrivateIp(url.hostname)) throw new Error("Dynamic OPML URL points to a private IP");
    return url;
  }

  const addresses = await dns.lookup(url.hostname, { all: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error("Dynamic OPML hostname resolves to a private IP");
  }
  return url;
}

async function fetchSafeOpml(url: string) {
  let current = (await assertSafeUrl(url)).toString();
  const maxBytes = 2 * 1024 * 1024;
  for (let redirect = 0; redirect < 6; redirect++) {
    await assertSafeUrl(current);
    const response = await fetch(current, {
      redirect: "manual",
      headers: { Accept: "text/x-opml,application/xml,text/xml,*/*", "User-Agent": "FeedFerret/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      current = new URL(response.headers.get("location")!, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`Dynamic OPML fetch failed: ${response.status}`);
    const text = await response.text();
    if (text.length > maxBytes) throw new Error("Dynamic OPML response too large");
    return text;
  }
  throw new Error("Dynamic OPML too many redirects");
}

function feedDataFromOutline(outline: OpmlOutline, userId: string, categoryId: string) {
  const frss = outline.frss ?? {};
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
    priority: frss.priority || "main",
    unicityCriteria: frss.unicityCriteria || "id",
    unicityCriteriaForced: frss.unicityCriteriaForced === "true" || frss.unicityCriteriaForced === "1",
    scraperConfig: stringifyNonEmpty(scraperConfig),
    httpOptions: stringifyNonEmpty(httpOptions),
    fullTextSelector: frss.cssFullContent || null,
    fullTextConditions: frss.cssFullContentConditions || null,
    fullTextRemoveSelectors: frss.cssContentFilter || frss.cssFullContentFilter || null,
    filtersActionRead: frss.filtersActionRead || null,
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
    update: { opmlUrl: outline.frss?.opmlUrl ?? undefined },
    create: { userId, name: outline.text, parentId: parentCategoryId, opmlUrl: outline.frss?.opmlUrl ?? undefined },
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
