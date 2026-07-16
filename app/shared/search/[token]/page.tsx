import Link from "next/link";
import { notFound } from "next/navigation";
import { Rss, ExternalLink } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { getPublicBaseUrl, getSharedSavedSearch, stripHtml } from "@/lib/saved-search-sharing";

export const dynamic = "force-dynamic";

export default async function SharedSearchPage({ params }: { params: Promise<{ token: string }> }) {
  const t = await getTranslations("sharedSearch");
  const format = await getFormatter();
  const { token } = await params;
  const result = await getSharedSavedSearch(token, 100);
  if (!result) notFound();

  const { savedSearch, articles } = result;
  const baseUrl = getPublicBaseUrl();
  const rssUrl = `/api/shared-search/${token}/rss`;

  return (
    <main className="min-h-dvh app-chrome px-4 py-8 text-foreground sm:px-6">
      <div className="mx-auto max-w-4xl">
        <header className="mb-8 rounded-[2rem] border border-border/70 bg-card/85 p-6 shadow-sm backdrop-blur-2xl">
          <div className="mb-3 text-sm font-medium text-muted-foreground">{t("title")}</div>
          <h1 className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">{savedSearch.name}</h1>
          <code className="mt-4 block rounded-2xl bg-muted/60 px-3 py-2 text-sm text-muted-foreground">{savedSearch.query}</code>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href={rssUrl} className="inline-flex h-10 items-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground">
              <Rss className="h-4 w-4" /> {t("rssFeed")}
            </Link>
            <Link href="/" className="inline-flex h-10 items-center gap-2 rounded-2xl border border-border/70 bg-background/70 px-4 text-sm font-semibold">
              {t("openFeedferret")}
            </Link>
          </div>
        </header>

        <section className="grid gap-3">
          {articles.map((article) => (
            <article key={article.id} className="rounded-[1.5rem] border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur-xl">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
                <span>{article.feed.icon || "📰"}</span>
                <span>{article.feed.name}</span>
                <span>·</span>
                <time dateTime={article.publishedAt.toISOString()}>{format.dateTime(article.publishedAt, { dateStyle: "medium" })}</time>
              </div>
              <h2 className="text-xl font-semibold tracking-[-0.03em]">
                {article.link ? (
                  <a href={article.link} target="_blank" rel="noreferrer" className="hover:underline">
                    {article.title}
                  </a>
                ) : article.title}
              </h2>
              <p className="mt-2 line-clamp-3 text-sm leading-6 text-muted-foreground">{article.excerpt || stripHtml(article.content).slice(0, 240)}</p>
              {article.link && (
                <a href={article.link} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-link">
                  {t("openOriginal")} <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </article>
          ))}
          {articles.length === 0 && (
            <div className="rounded-[1.5rem] border border-border/60 bg-card/80 p-10 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-muted">
                <Rss className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="font-medium text-foreground">{t("noMatchingArticles")}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t("noResults")}</p>
            </div>
          )}
        </section>

        <footer className="mt-8 text-center text-xs text-muted-foreground">
          {t("publicUrl")} {baseUrl}/shared/search/{token}
        </footer>
      </div>
    </main>
  );
}
