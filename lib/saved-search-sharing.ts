import { db } from "@/lib/db";
import { buildAdvancedSearchWhere } from "@/lib/search";

export async function getSharedSavedSearch(token: string, limit = 100) {
  if (!token || token.length < 16) return null;

  const savedSearch = await db.savedSearch.findUnique({
    where: { shareToken: token },
    include: {
      user: { select: { name: true, email: true } },
    },
  });
  if (!savedSearch?.shareToken) return null;

  const searchWhere = await buildAdvancedSearchWhere(savedSearch.userId, savedSearch.query);
  const articles = await db.article.findMany({
    where: {
      userId: savedSearch.userId,
      AND: [searchWhere],
    },
    include: { feed: true, labels: { include: { label: true } } },
    orderBy: { publishedAt: "desc" },
    take: limit,
  });

  return { savedSearch, articles };
}

export function getPublicBaseUrl() {
  return (
    process.env.AUTH_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

export function stripHtml(input?: string | null) {
  return (input || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function escapeXml(input?: string | null) {
  return (input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
