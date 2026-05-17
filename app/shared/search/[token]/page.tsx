import Link from "next/link";
import { notFound } from "next/navigation";
import { Rss, ExternalLink } from "lucide-react";
import { getPublicBaseUrl, getSharedSavedSearch, stripHtml } from "@/lib/saved-search-sharing";

export const dynamic = "force-dynamic";

export default async function SharedSearchPage({ params }: { params: Promise<{ token: string }> }) {
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
          <div className="mb-3 text-sm font-medium text-muted-foreground">Shared FeedFerret search</div>
          <h1 className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">{savedSearch.name}</h1>
          <code className="mt-4 block rounded-2xl bg-muted/60 px-3 py-2 text-sm text-muted-foreground">{savedSearch.query}</code>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href={rssUrl} className="inline-flex h-10 items-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground">
              <Rss className="h-4 w-4" /> RSS feed
            </Link>
            <Link href="/" className="inline-flex h-10 items-center gap-2 rounded-2xl border border-border/70 bg-background/70 px-4 text-sm font-semibold">
              Open FeedFerret
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
                <time dateTime={article.publishedAt.toISOString()}>{article.publishedAt.toLocaleDateString()}</time>
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
                <a href={article.link} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-accent">
                  Open original <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </article>
          ))}
          {articles.length === 0 && (
            <div className="rounded-[1.5rem] border border-border/60 bg-card/80 p-10 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-muted">
                <Rss className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="font-medium text-foreground">No matching articles</p>
              <p className="mt-1 text-sm text-muted-foreground">This search has no results yet. Check back after the next sync.</p>
            </div>
          )}
        </section>

        <footer className="mt-8 text-center text-xs text-muted-foreground">
          Public URL: {baseUrl}/shared/search/{token}
        </footer>
      </div>
    </main>
  );
}
