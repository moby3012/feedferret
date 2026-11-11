/** Opt-in live benchmark. See README.md; never imported by CI/tests. */
import { fork } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

async function main() {
  type Site = { id: string; category: string; url: string; expectation: string };
  const args = process.argv.slice(2);
  if (process.env.CI) throw new Error('Live benchmark refuses to run in CI');
  const flag = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const self = fileURLToPath(import.meta.url);
  const timeoutMs = Number(flag('--timeout-ms', '90000'));
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('Invalid timeout');
  const cleanError = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/https?:\/\/[^\s]+/g, '[URL]').slice(0, 250);

  if (args.includes('--worker')) {
    // Use only the throwaway SQLite DB; never inherit connector keys/URLs or trust overrides.
    for (const key of Object.keys(process.env)) {
      if (/^(FEEDFERRET_|TRUSTED_FEED_FETCHING$|ALLOW_INTERNAL_FEED_URLS$)/.test(key)) delete process.env[key];
    }
    process.env.DATABASE_PROVIDER = 'sqlite';
    if (!process.env.DATABASE_URL?.startsWith('file:')) throw new Error('SQLite DATABASE_URL required');
    const site: Site = JSON.parse(flag('--worker', '{}'));
    const started = Date.now();
    const trace: { status?: number; error?: string }[] = [];
    // App discovery has batches of five. Limit native network operations to three,
    // including response consumption, while preserving app headers and SSRF checks.
    const originalFetch = globalThis.fetch;
    let active = 0;
    const queue: (() => void)[] = [];
    globalThis.fetch = async (...a: Parameters<typeof fetch>) => {
      if (active >= 3) await new Promise<void>(r => queue.push(r));
      active++;
      let released = false;
      const release = () => { if (released) return; released = true; active--; queue.shift()?.(); };
      try {
        const response = await originalFetch(...a);
        trace.push({ status: response.status });
        if (!response.body) { release(); return response; }
        if (!response.ok) { await response.body.cancel(); release(); return response; }
        const reader = response.body.getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try { const result = await reader.read(); if (result.done) { release(); controller.close(); } else controller.enqueue(result.value); }
            catch (e) { release(); controller.error(e); }
          },
          async cancel(reason) { release(); await reader.cancel(reason); },
        });
        const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        Object.defineProperty(wrapped, 'url', { value: response.url });
        return wrapped;
      } catch (e) { trace.push({ error: cleanError(e) }); release(); throw e; }
    };
    const { db } = await import('../../lib/db');
    const { isTrustedFeedFetchingAllowed, assertSafeFetchUrl } = await import('../../lib/ssrf');
    const { discoverFeeds } = await import('../../lib/feed-discovery');
    const { fetchFeedArticles } = await import('../../lib/feed-fetcher');
    const { fetchAndSuggestFeedCandidates } = await import('../../lib/page-feed-suggest');
    const { matchRadarRules } = await import('../../lib/rsshub-radar-rules');
    const { getRsshubConfig } = await import('../../lib/rsshub');
    const { getRenderSidecarConfig } = await import('../../lib/render-sidecar');
    const errors: string[] = [];
    const attempts: unknown[] = [];
    let method = 'failed', selected: unknown = null;
    let articles: import('../../lib/feed-fetcher').FetchedFeedArticle[] = [];
    let itemCount = 0;
    let candidates: import('../../lib/feed-discovery').DiscoveredFeed[] = [];
    let selectorConfig: unknown = null;
    try {
      if (await isTrustedFeedFetchingAllowed()) throw new Error('Internal URL access must be disabled');
      if (await getRsshubConfig() || await getRenderSidecarConfig()) throw new Error('Baseline requires unconfigured RSSHub/render services');
      await assertSafeFetchUrl(site.url);
      // A pasted explicit feed is accepted by the add action directly.
      if (/\/(?:rss|feed|atom)(?:[/.?]|$)/i.test(new URL(site.url).pathname)) candidates.push({ url: site.url, title: '', type: 'unknown' });
      else candidates = (await discoverFeeds(site.url, { locale: 'de' })).feeds;
      // At most three candidate validations; each attempt is retained (never silently success).
      for (const candidate of candidates.slice(0, 3)) {
        try {
          const feed = await fetchFeedArticles({ url: candidate.url, sourceType: candidate.type === 'json' ? 'JSONFeed' : 'RSS', fetchTimeoutSecs: 12, maxSizeKb: 2048 });
          attempts.push({ candidate, itemCount: feed.articles.length });
          if (feed.articles.length) {
            articles = feed.articles; itemCount = articles.length; selected = candidate;
            method = candidate.source === 'radar' ? 'converter-RSSHub' : !candidate.source ? 'native-feed' : candidate.source === 'resolver' ? 'native-converter' : 'discovered';
            break;
          }
        } catch (e) { const error = cleanError(e); errors.push(error); attempts.push({ candidate, error }); }
      }
      if (!articles.length) {
        try {
          const suggestions = await fetchAndSuggestFeedCandidates(site.url);
          if (suggestions.length) {
            const best = suggestions[0];
            articles = best.previewArticles; itemCount = best.itemCount; selectorConfig = best.config;
            selected = { score: best.score, alternatives: suggestions.length, quality: best.quality };
            method = 'selector';
          }
        } catch (e) { errors.push(cleanError(e)); }
      }
      // Preview success is provisional: titles/links cannot prove intended semantic scope.
      const quality = {
        sampled: articles.length,
        titles: articles.filter(a => a.title?.trim() && a.title !== 'Untitled').length,
        links: articles.filter(a => a.link?.trim()).length,
        absoluteLinks: articles.filter(a => /^https?:\/\//.test(a.link)).length,
        parsedDates: articles.filter(a => a.publishedAt && Number.isFinite(new Date(a.publishedAt).getTime())).length,
        images: articles.filter(a => !!a.imageUrl).length,
      };
      process.send?.({ ...site, method, elapsedMs: Date.now() - started, itemCount, quality, selected, candidates, attempts, selectorConfig,
        sample: articles.slice(0, 5).map(a => ({ title: a.title, link: a.link })),
        needs: { rsshubRoutes: matchRadarRules(site.url), render: !(await getRenderSidecarConfig()) && !articles.length ? 'unconfigured; fallback available, efficacy untested' : null },
        errors, trace });
    } catch (e) { process.send?.({ ...site, method: 'failed', elapsedMs: Date.now() - started, errors: [cleanError(e)], trace }); }
    finally { await db.$disconnect(); process.exit(0); }
  } else {
    if (!args.includes('--live')) throw new Error('Pass --live to authorize public network requests');
    const sites: Site[] = JSON.parse(await readFile(new URL('./feed-everything.sites.json', import.meta.url), 'utf8'));
    const output = flag('--output', '/tmp/feed-everything.results.json');
    const results: unknown[] = [];
    for (const site of sites.filter(s => !args.includes('--only') || s.id === flag('--only', ''))) {
      const result = await new Promise<unknown>(resolve => {
        let done = false;
        const siteStarted = Date.now();
        const child = fork(self, ['--worker', JSON.stringify(site)], { execArgv: process.execArgv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        const finish = (value: unknown) => { if (done) return; done = true; clearTimeout(timer); child.kill('SIGKILL'); resolve(value); };
        const timer = setTimeout(() => finish({ ...site, method: 'failed', elapsedMs: timeoutMs, errors: ['worker deadline exceeded; pending requests killed'] }), timeoutMs);
        child.on('message', finish);
        child.on('error', e => finish({ ...site, method: 'failed', elapsedMs: Date.now() - siteStarted, errors: [cleanError(e)] }));
        child.on('exit', (code, signal) => finish({ ...site, method: 'failed', elapsedMs: Date.now() - siteStarted, errors: [`worker exited without result (code=${code}, signal=${signal})`] }));
      });
      results.push(result);
      await writeFile(output, JSON.stringify({ recordedAt: new Date().toISOString(), timeoutMs, rsshub: false, renderSidecar: false, results }, null, 2) + '\n');
      console.log(JSON.stringify(result));
      await new Promise(r => setTimeout(r, 750));
    }
  }

}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Benchmark failed");
  process.exitCode = 1;
});
