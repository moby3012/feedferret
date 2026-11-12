import { presentMedia } from "@/lib/media-proxy";
import { QueryClient, dehydrate, type DehydratedState } from "@tanstack/react-query";
import { qk } from "@/features/articles/keys";
import { PAGE_SIZE } from "@/features/articles/api";
import { briefingKey, showsBriefing } from "@/features/briefing/api";
import { listKeyOfLoc, parseLoc } from "@/features/reader/nav/location";
import { getBriefingState } from "@/lib/briefing/generate";
import { getArticleDetail } from "@/server/articles/detail";
import { listArticles } from "@/server/articles/list";
import { getBootstrap } from "@/server/bootstrap";
import { logger } from "@/lib/logger";

/**
 * Cold-start cache of the reader shell (.pm/spec-shell-design.md §2.5): the
 * entity keys, `counts`, the first page of the list the URL points at and the
 * open article's detail (and, on the Neu list, the K2 briefing card's state —
 * its query starts with the list's, spec K2), written into a request-scoped QueryClient and
 * dehydrated for `<HydrationBoundary>`. The client then paints the first rows
 * from the streamed HTML and starts with zero data requests.
 *
 * Every entry has exactly the shape (and query key) the client queries use:
 * the entity keys come from the same loaders as the read server actions, the
 * list page is the `useInfiniteQuery` shape of `GET /api/app/articles`.
 */
export async function buildBootstrapState(userId: string, href: string): Promise<DehydratedState> {
  const qc = new QueryClient();
  const boot = await getBootstrap(userId);
  qc.setQueryData(qk.feeds, boot.feeds);
  qc.setQueryData(qk.categories, boot.categories);
  qc.setQueryData(qk.labels, boot.labels);
  qc.setQueryData(qk.savedSearches, boot.savedSearches);
  qc.setQueryData(qk.prefs, boot.prefs);
  qc.setQueryData(qk.counts, boot.counts);
  qc.setQueryData(qk.notifications, boot.notifications);

  const query = href.includes("?") ? href.slice(href.indexOf("?")) : "";
  const loc = parseLoc(query);
  // Same sort the shell starts with (components/shell/shell-context.tsx).
  const key = listKeyOfLoc(loc, boot.prefs.defaultArticleSort === "oldest" ? "old" : "new");
  const [page, detail, briefing] = await Promise.all([
    key && loc.scope
      ? listArticles(userId, { scope: loc.scope, show: key.show, sort: key.sort, limit: PAGE_SIZE }).catch((error) => {
          // An unknown scope id (stale link) is the client's to handle — as before, through its own request.
          logger.warn("[bootstrap] list prefetch failed:", error);
          return null;
        })
      : null,
    loc.articleId ? getArticleDetail(userId, loc.articleId).catch(() => null) : null,
    // GET semantics: cached briefing or headline digest, never a provider call.
    // The JSON round trip gives the client exactly the `GET /api/app/briefing` body.
    showsBriefing(loc.tab, loc)
      ? getBriefingState(userId, { kind: "new" })
          .then((state) => JSON.parse(JSON.stringify(state)) as typeof state)
          .catch((error) => {
            logger.warn("[bootstrap] briefing prefetch failed:", error);
            return null;
          })
      : null,
  ]);
  if (key && page) qc.setQueryData(qk.list(key), { pages: [{ ...page, items: await presentMedia(page.items, userId) }], pageParams: [null] });
  if (loc.articleId && detail) qc.setQueryData(qk.article(loc.articleId), (await presentMedia([detail], userId))[0]);
  if (briefing) qc.setQueryData(briefingKey("new"), briefing);

  return dehydrate(qc);
}
