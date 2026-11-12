/**
 * Opt-in live benchmark over OPML files / JSON site lists. See README.md
 * ("bench-opml"). Never imported by CI/tests. Run through scripts/bench-opml.mjs.
 *
 * Measures, per feed/site, using the app's own functions (no reimplementation):
 *   health     fetchFeedArticles + fetchWithSsrfProtection (status/redirect/size)
 *   discovery  discoverFeeds(htmlUrl) and discoverFeeds(bare domain)
 *   pagefeed   fetchAndSuggestFeedCandidatesDetailed (sites without a feed only)
 *   fulltext   fetchAndExtractReadable + configured full-text selector + app quality gate,
 *              scored against the feed item (bench-only scoring, see scoreExtraction)
 *   ai         buildExtractionPrompt / buildFeedConfigPrompt dry-run (no model call);
 *              live extractArticleWithAi only with --ai and a BENCH_AI_* provider env
 */
import { fork, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// ---------------------------------------------------------------- types
type Entry = {
  id: string;
  kind: 'feed' | 'site';
  /** feed: the subscribed feed URL. site: unset (discovered). */
  feedUrl?: string;
  /** feed: OPML htmlUrl if any. site: the page URL to test. */
  htmlUrl?: string;
  fullTextSelector?: string;
  fullTextRemoveSelectors?: string;
  title?: string;
  category?: string;
  platform?: string;
  /** Known native feed endpoint for a platform URL (verified separately). */
  nativeFeed?: string;
  expectation?: string;
  /** Which bundled lists/input files contained this entry. */
  sources: string[];
  /** Entry is a known placeholder (RFC 2606 / file:) → reported, never fetched. */
  placeholder?: string;
};

type Options = {
  stages: Set<string>;
  articles: number;
  delayMs: number;
  timeoutMs: number;
  workerTimeoutMs: number;
  cacheDir: string;
  snapshot: boolean;
  robots: boolean;
  render: boolean;
  rsshub: boolean;
  ai: boolean;
};

const BENCH_UA = 'FeedFerret/1.0 (+https://github.com/moby3012/feedferret) bench-opml';
const ALL_STAGES = ['health', 'discovery', 'pagefeed', 'fulltext', 'ai-dryrun'];

// ---------------------------------------------------------------- small helpers
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const now = () => Date.now();

/** Mask credentials in URLs/messages (query keys like token/key/auth/sig, userinfo). */
function maskUrl(raw: string | undefined | null): string | undefined {
  if (!raw) return raw ?? undefined;
  return raw
    .replace(/([?&#;][\w.-]*(?:key|token|secret|passw(?:or)?d|pwd|auth|sig(?:nature)?|session)=)[^&#\s"']*/gi, '$1***')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, '$1***@');
}
function cleanError(e: unknown) {
  return maskUrl(String(e instanceof Error ? e.message : e).replace(/\s+/g, ' ').slice(0, 240)) ?? '';
}
function hostOf(u: string | undefined) {
  try { return u ? new URL(u).hostname.toLowerCase() : ''; } catch { return ''; }
}
const bareHost = (h: string) => h.replace(/^(www|m|mobile)\./, '');
/** Comparable feed URL: no scheme, no www., no trailing slash, sorted query. */
function normUrl(u: string | undefined): string {
  if (!u) return '';
  try {
    const url = new URL(u);
    url.hash = '';
    const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    const q = params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';
    return `${bareHost(url.hostname.toLowerCase())}${url.port ? ':' + url.port : ''}${url.pathname.replace(/\/+$/, '')}${q}`;
  } catch { return u.trim().toLowerCase(); }
}
function classifyError(msg: string): { cls: string; status?: number } {
  const m = msg.match(/(?:Fetch failed|HTTP)[: ]+(\d{3})/i);
  if (m) {
    const status = Number(m[1]);
    return { cls: status >= 500 ? 'http-5xx' : `http-${status}`, status };
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS/i.test(msg)) return { cls: 'dns' };
  if (/abort|timed? ?out|timeout|deadline/i.test(msg)) return { cls: 'timeout' };
  if (/certificate|SSL|TLS|CERT_/i.test(msg)) return { cls: 'tls' };
  if (/ECONNREFUSED|ECONNRESET|socket|other side closed|UND_ERR/i.test(msg)) return { cls: 'connection' };
  if (/private IP|not allowed|SSRF|blocked/i.test(msg)) return { cls: 'ssrf-policy' };
  if (/too large|exceeds|maxBytes|size limit/i.test(msg)) return { cls: 'too-large' };
  if (/redirect/i.test(msg)) return { cls: 'redirect' };
  if (/Non-whitespace|Unexpected|parse|Invalid|not a feed|Feed not recognized|XML/i.test(msg)) return { cls: 'parse' };
  return { cls: 'other' };
}
function plainText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

// ---------------------------------------------------------------- extraction scoring (bench-only measurement)
/** Multilingual, host-agnostic wall/consent/paywall lexicon. */
const CONSENT_RE = /\b(cookie[s-]?|consent|einwillig\w*|zustimm\w*|alle akzeptieren|accept all|datenschutzeinstellungen|privacy settings|manage preferences|tracking|werbefrei|pur[- ]abo|pur bestellen|ohne werbung)\b/gi;
const PAYWALL_RE = /\b(subscribe (?:now|to (?:continue|read))|subscribers? only|already a subscriber|bereits abonnent|jetzt abonnieren|abo abschließen|weiterlesen mit|plus[- ]artikel|paywall|members? only|become a member|sign in to (?:continue|read)|log in to (?:continue|read)|this content is for)\b/gi;
const BOT_RE = /\b(enable javascript|javascript (?:is )?(?:required|disabled)|verify you are (?:a )?human|captcha|are you a robot|access denied|checking your browser|just a moment|attention required|unusual traffic)\b/gi;
const CTA_RE = /\b(newsletter|related (?:articles|posts|stories)|weitere artikel|mehr zum thema|read more|share (?:this|on)|teilen|follow us|anzeige|advertisement|sponsored|kommentare|comments)\b/gi;

function countMatches(re: RegExp, text: string) { return (text.match(re) || []).length; }
function sentences(text: string) {
  return text.split(/(?<=[.!?…])\s+/).map(s => s.trim()).filter(s => s.length >= 40);
}
function normWords(s: string) { return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

export type FulltextScore = {
  verdict: 'good' | 'partial' | 'fail';
  reason: string;
  feedChars: number;
  extractedChars: number;
  ratio: number | null;
  linkDensity: number;
  keyOverlap: number | null;
  consentHits: number;
  paywallHits: number;
  botHits: number;
  edgeBoilerplate: boolean;
  paywallMeta: boolean;
};

function scoreExtraction(feedHtml: string, extractedHtml: string | null, pageHtml: string | null): FulltextScore {
  const feedPlain = plainText(feedHtml);
  const ext = plainText(extractedHtml);
  const linkText = [...(extractedHtml || '').matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map(m => plainText(m[1])).join(' ');
  const linkDensity = ext.length ? Math.min(1, linkText.length / ext.length) : 0;
  const feedSentences = sentences(feedPlain).slice(0, 6);
  const extNorm = normWords(ext);
  const keyOverlap = feedSentences.length
    ? feedSentences.filter(s => extNorm.includes(normWords(s).split(' ').slice(0, 8).join(' '))).length / feedSentences.length
    : null;
  const consentHits = countMatches(CONSENT_RE, ext);
  const paywallHits = countMatches(PAYWALL_RE, ext);
  const botHits = countMatches(BOT_RE, ext);
  const edges = ext.slice(0, 300) + ' ' + ext.slice(-300);
  const edgeBoilerplate = countMatches(CTA_RE, edges) + countMatches(CONSENT_RE, edges) + countMatches(PAYWALL_RE, edges) >= 2;
  const paywallMeta = /"isAccessibleForFree"\s*:\s*"?(?:false|False)/.test(pageHtml || '');
  const ratio = feedPlain.length ? ext.length / feedPlain.length : null;
  const base = { feedChars: feedPlain.length, extractedChars: ext.length, ratio, linkDensity: Number(linkDensity.toFixed(3)), keyOverlap, consentHits, paywallHits, botHits, edgeBoilerplate, paywallMeta };
  const per1k = (n: number) => (ext.length ? (n * 1000) / ext.length : 0);

  if (!extractedHtml || ext.length < 200) {
    const page = plainText(pageHtml);
    if (countMatches(BOT_RE, page) > 0 && page.length < 3000) return { ...base, verdict: 'fail', reason: 'bot-challenge' };
    if (page.length < 600) return { ...base, verdict: 'fail', reason: 'js-shell-or-empty' };
    return { ...base, verdict: 'fail', reason: 'no-content-extracted' };
  }
  if (botHits > 0 && ext.length < 2000) return { ...base, verdict: 'fail', reason: 'bot-challenge' };
  if (consentHits >= 2 && (ext.length < 2500 || per1k(consentHits) > 3)) return { ...base, verdict: 'fail', reason: 'consent-wall' };
  if ((paywallHits >= 1 || paywallMeta) && ext.length < Math.max(1500, feedPlain.length * 1.2)) return { ...base, verdict: 'fail', reason: 'paywall-stub' };
  if (feedPlain.length >= 1000 && ext.length < feedPlain.length * 0.6) return { ...base, verdict: 'fail', reason: 'worse-than-feed' };
  if (keyOverlap === 0 && feedSentences.length >= 2) return { ...base, verdict: 'partial', reason: 'content-mismatch' };
  if (linkDensity > 0.35) return { ...base, verdict: 'partial', reason: 'link-heavy-boilerplate' };
  if (feedPlain.length < 1500 && ext.length < Math.max(feedPlain.length * 1.2, 600)) return { ...base, verdict: 'partial', reason: 'teaser-no-gain' };
  if (paywallHits >= 1 || paywallMeta) return { ...base, verdict: 'partial', reason: 'paywall-signals' };
  if (edgeBoilerplate) return { ...base, verdict: 'partial', reason: 'edge-boilerplate' };
  if (feedPlain.length >= 1500 && ext.length < feedPlain.length * 1.2) return { ...base, verdict: 'good', reason: 'feed-already-full' };
  return { ...base, verdict: 'good', reason: 'ok' };
}

// ---------------------------------------------------------------- input collection
async function readOpmlEntries(file: string, label: string): Promise<Entry[]> {
  const { parseOpml } = await import('../../lib/opml');
  type Outline = { xmlUrl?: string; htmlUrl?: string; text?: string; title?: string; category?: string; extensions?: Record<string, string>; children?: Outline[] };
  const flatten = (outlines: Outline[], cat = ''): Entry[] => outlines.flatMap(o => o.xmlUrl
    ? [{ id: '', kind: 'feed' as const, feedUrl: o.xmlUrl, fullTextSelector: o.extensions?.cssFullContent, fullTextRemoveSelectors: o.extensions?.cssContentFilter, htmlUrl: o.htmlUrl || undefined, title: o.text || o.title, category: o.category || cat, sources: [label] }]
    : flatten(o.children || [], o.text || cat));
  return flatten(await parseOpml(await readFile(file, 'utf8')) as Outline[]);
}
async function readSitesJson(file: string, label: string): Promise<Entry[]> {
  const raw = JSON.parse(await readFile(file, 'utf8')) as Array<Record<string, string>>;
  return raw.map(s => s.feedUrl || s.xmlUrl
    ? { id: s.id || '', kind: 'feed' as const, feedUrl: s.feedUrl || s.xmlUrl, htmlUrl: s.htmlUrl || s.url, title: s.title, category: s.category, platform: s.platform, sources: [label] }
    : { id: s.id || '', kind: 'site' as const, htmlUrl: s.url, title: s.title || s.id, category: s.category, platform: s.platform, nativeFeed: s.nativeFeed, expectation: s.expectation, sources: [label] });
}
/** Every example list FeedFerret ships (starter packs, catalog, publisher table, bench lists, import fixtures). */
async function collectBundled(root: string): Promise<Entry[]> {
  const out: Entry[] = [];
  const opmlDir = path.join(root, 'public/starter-opml');
  for (const f of ['tech', 'science', 'news', 'dev', 'design']) out.push(...await readOpmlEntries(path.join(opmlDir, `${f}.opml`), `starter-opml/${f}`));
  const { SEED_FEEDS } = await import('../../lib/discovery-catalog-seeds');
  for (const s of SEED_FEEDS) out.push({ id: '', kind: 'feed', feedUrl: s.url, title: s.title, category: s.category, sources: ['discovery-catalog'] });
  const { allPublisherFeedUrls } = await import('../../lib/publisher-feeds');
  for (const u of allPublisherFeedUrls()) out.push({ id: '', kind: 'feed', feedUrl: u, category: 'publisher-table', sources: ['publisher-feeds'] });
  out.push(...await readSitesJson(path.join(root, 'scripts/bench/feed-everything.sites.json'), 'feed-everything-sites'));
  out.push(...await readSitesJson(path.join(root, 'scripts/bench/platforms.sites.json'), 'platforms'));
  out.push(...await readOpmlEntries(path.join(root, 'tests/fixtures/freshrss/feeds_2026-11-09.opml.xml'), 'fixture-freshrss'));
  return out;
}
function finalizeEntries(raw: Entry[]): Entry[] {
  const byKey = new Map<string, Entry>();
  for (const e of raw) {
    const key = e.kind === 'feed' ? 'feed:' + normUrl(e.feedUrl) : 'site:' + normUrl(e.htmlUrl);
    const prev = byKey.get(key);
    if (prev) {
      prev.sources = [...new Set([...prev.sources, ...e.sources])];
      prev.fullTextSelector ||= e.fullTextSelector; prev.fullTextRemoveSelectors ||= e.fullTextRemoveSelectors;
      prev.htmlUrl ||= e.htmlUrl; prev.title ||= e.title; prev.id ||= e.id; prev.platform ||= e.platform; prev.nativeFeed ||= e.nativeFeed;
      continue;
    }
    const target = e.feedUrl || e.htmlUrl || '';
    let placeholder: string | undefined;
    try {
      const u = new URL(target);
      if (!/^https?:$/.test(u.protocol)) placeholder = `non-http scheme ${u.protocol}`;
      else if (/(^|\.)example\.(com|org|net)$|\.(test|invalid|localhost)$/.test(u.hostname)) placeholder = 'RFC 2606 example host';
    } catch { placeholder = 'invalid URL'; }
    byKey.set(key, { ...e, placeholder });
  }
  return [...byKey.values()].map(e => ({ ...e, id: e.id || `${e.kind}-${sha1((e.feedUrl || e.htmlUrl || '')).slice(0, 10)}` }));
}

// ---------------------------------------------------------------- worker
async function runWorker(entry: Entry, opt: Options) {
  // Throwaway SQLite DB only; never inherit connector keys/URLs or trust overrides
  // unless the matching helper flag was passed explicitly.
  for (const key of Object.keys(process.env)) {
    if (/^(TRUSTED_FEED_FETCHING|ALLOW_INTERNAL_FEED_URLS)$/.test(key)) delete process.env[key];
    if (!key.startsWith('FEEDFERRET_')) continue;
    if (opt.render && key.startsWith('FEEDFERRET_RENDER_SIDECAR_')) continue;
    if (opt.rsshub && key.startsWith('FEEDFERRET_RSSHUB_')) continue;
    delete process.env[key];
  }
  process.env.DATABASE_PROVIDER = 'sqlite';
  if (!process.env.DATABASE_URL?.startsWith('file:')) throw new Error('SQLite DATABASE_URL required');

  const ssrf = await import('../../lib/ssrf');
  const { db } = await import('../../lib/db');
  const { fetchFeedArticles } = await import('../../lib/feed-fetcher');
  const { discoverFeeds } = await import('../../lib/feed-discovery');
  const { fetchAndSuggestFeedCandidatesDetailed } = await import('../../lib/page-feed-suggest');
  const { fetchAndExtractReadable } = await import('../../lib/readability-extract');
  const { RecentFullTextIndex, baselinesDiffer } = await import('../../lib/full-text-duplicates');
  const { decideFullText, leadCoverage } = await import('../../lib/extraction-quality');
  const { matchRadarRules } = await import('../../lib/rsshub-radar-rules');
  const { getRsshubConfig } = await import('../../lib/rsshub');
  const { getRenderSidecarConfig } = await import('../../lib/render-sidecar');
  const { buildExtractionPrompt } = await import('../../lib/ai-extraction');
  const { buildFeedConfigPrompt } = await import('../../lib/ai-feed-config');

  const started = now();
  const result: Record<string, unknown> = {
    id: entry.id, kind: entry.kind, title: entry.title, category: entry.category, platform: entry.platform,
    sources: entry.sources, feedUrl: maskUrl(entry.feedUrl), htmlUrl: maskUrl(entry.htmlUrl), expectation: entry.expectation,
  };
  const errors: string[] = [];
  let requests = 0;
  let lastRequestAt = 0;
  /** Serial, delayed network calls (the worker only ever handles hosts the parent locked for it). */
  const polite = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const wait = lastRequestAt + opt.delayMs - now();
    if (wait > 0) await sleep(wait);
    requests++;
    try { return await fn(); } finally { lastRequestAt = now(); }
  };
  const cacheWrite = async (kind: string, url: string, body: string, meta: Record<string, unknown>) => {
    if (!opt.snapshot) return;
    const dir = path.join(opt.cacheDir, kind);
    await mkdir(dir, { recursive: true });
    const name = sha1(url);
    await writeFile(path.join(dir, `${name}.gz`), gzipSync(body));
    await writeFile(path.join(dir, `${name}.meta.json`), JSON.stringify({ url: maskUrl(url), fetchedAt: new Date().toISOString(), ...meta }, null, 2));
  };

  // robots.txt: one cached copy per host (shared across workers via the cache dir), 24 h.
  const robotsCache = new Map<string, Array<{ allow: boolean; path: string }>>();
  const robotsRules = async (u: URL) => {
    if (robotsCache.has(u.origin)) return robotsCache.get(u.origin)!;
    const file = path.join(opt.cacheDir, 'robots', `${sha1(u.origin)}.txt`);
    let text = '';
    try {
      const st = await stat(file);
      if (now() - st.mtimeMs < 86_400_000) text = await readFile(file, 'utf8');
      else throw new Error('stale');
    } catch {
      try {
        const res = await polite(() => ssrf.fetchWithSsrfProtection(`${u.origin}/robots.txt`, { headers: { 'User-Agent': BENCH_UA } }, { maxBytes: 256 * 1024, timeoutMs: 8000, maxRedirects: 3 }));
        text = res.notModified ? '' : res.text;
      } catch { text = ''; }
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    }
    // Groups for "*" or "feedferret"; Allow/Disallow prefix rules (no wildcard extensions).
    const rules: Array<{ allow: boolean; path: string }> = [];
    let agents: string[] = [];
    let inRules = false;
    for (const line of text.split(/\r?\n/)) {
      const m = line.replace(/#.*/, '').trim().match(/^([\w-]+)\s*:\s*(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (/^user-agent$/i.test(k)) { if (inRules) { agents = []; inRules = false; } agents.push(v.toLowerCase()); continue; }
      inRules = true;
      if (!agents.some(a => a === '*' || a.includes('feedferret'))) continue;
      if (/^disallow$/i.test(k) && v) rules.push({ allow: false, path: v });
      if (/^allow$/i.test(k) && v) rules.push({ allow: true, path: v });
    }
    robotsCache.set(u.origin, rules);
    return rules;
  };
  const robotsAllowed = async (raw: string) => {
    if (!opt.robots) return true;
    try {
      const u = new URL(raw);
      const p = u.pathname + u.search;
      // RFC 9309: "*" wildcard, trailing "$" anchor, longest match wins, Allow wins ties.
      const toRe = (pattern: string) => new RegExp('^' + pattern.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\?\$$/, '$'));
      const match = (await robotsRules(u))
        .filter(r => toRe(r.path).test(p))
        .sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow))[0];
      return !match || match.allow;
    } catch { return true; }
  };

  try {
    if (await ssrf.isTrustedFeedFetchingAllowed()) throw new Error('Internal URL access must be disabled');
    const rsshubConfigured = !!(await getRsshubConfig());
    const renderConfigured = !!(await getRenderSidecarConfig());
    result.helpers = {
      rsshub: rsshubConfigured,
      renderSidecar: renderConfigured,
      changedetection: !!process.env.FEEDFERRET_CHANGEDETECTION_URL,
      hosted: false, // per-user BYOK; the bench has no users.
      ai: opt.ai && !!process.env.BENCH_AI_PROVIDER,
    };

    let feedUrl = entry.feedUrl;
    type Article = import('../../lib/feed-fetcher').FetchedFeedArticle;
    let articles: Article[] = [];
    let feedHtmlUrl: string | null = null;

    // ---------- site entries: discovery first (that IS the feed-creation path)
    const discoveryRun = async (input: string) => {
      const t = now();
      if (!(await robotsAllowed(/^https?:/.test(input) ? input : `https://${input}/`))) return { input: maskUrl(input), skipped: 'robots-disallowed' };
      try {
        const r = await polite(() => discoverFeeds(input, { locale: 'de' }));
        const seen = new Map<string, number>();
        for (const f of r.feeds) seen.set(normUrl(f.url), (seen.get(normUrl(f.url)) || 0) + 1);
        const sources: Record<string, number> = {};
        for (const f of r.feeds) sources[f.source || 'unknown'] = (sources[f.source || 'unknown'] || 0) + 1;
        return {
          input: maskUrl(input), ms: now() - t, mode: r.mode, hint: r.hint, count: r.feeds.length,
          duplicates: [...seen.values()].filter(n => n > 1).length, sources,
          candidates: r.feeds.slice(0, 10).map(f => ({ url: maskUrl(f.url), type: f.type, source: f.source, platform: f.platform, kind: f.kind })),
          raw: r.feeds,
        };
      } catch (e) { return { input: maskUrl(input), ms: now() - t, error: cleanError(e), count: 0, raw: [] as import('../../lib/feed-discovery').DiscoveredFeed[] }; }
    };
    const stripRaw = <T extends { raw?: unknown }>(d: T) => { const { raw: _raw, ...rest } = d; void _raw; return rest; };

    if (entry.kind === 'site' && entry.htmlUrl) {
      const d = await discoveryRun(entry.htmlUrl);
      const tried: unknown[] = [];
      for (const c of (d.raw || []).slice(0, 3)) {
        try {
          const feed = await polite(() => fetchFeedArticles({ url: c.url, sourceType: c.type === 'json' ? 'JSONFeed' : 'RSS', fetchTimeoutSecs: Math.ceil(opt.timeoutMs / 1000), maxSizeKb: 5120 }));
          tried.push({ url: maskUrl(c.url), source: c.source, items: feed.articles.length });
          if (feed.articles.length) { feedUrl = c.url; articles = feed.articles; feedHtmlUrl = feed.htmlUrl ?? null; break; }
        } catch (e) { tried.push({ url: maskUrl(c.url), source: c.source, error: cleanError(e) }); }
      }
      const via = feedUrl ? (d.raw || []).find(f => f.url === feedUrl) : undefined;
      result.siteDiscovery = { ...stripRaw(d), validated: tried, feedFound: !!feedUrl, feedUrl: maskUrl(feedUrl), via: via ? { source: via.source, platform: via.platform, kind: via.kind } : null };
      result.radarRoutes = matchRadarRules(entry.htmlUrl).map(r => r.route);

      if (entry.nativeFeed) {
        try {
          const nf = await polite(() => fetchFeedArticles({ url: entry.nativeFeed!, fetchTimeoutSecs: Math.ceil(opt.timeoutMs / 1000), maxSizeKb: 5120 }));
          result.nativeFeed = { url: maskUrl(entry.nativeFeed), ok: nf.articles.length > 0, items: nf.articles.length, discovered: (d.raw || []).some(f => normUrl(f.url) === normUrl(entry.nativeFeed)) };
          if (!feedUrl && nf.articles.length) { articles = nf.articles; feedHtmlUrl = nf.htmlUrl ?? null; result.fulltextFeedFrom = 'nativeFeed'; }
        } catch (e) {
          result.nativeFeed = { url: maskUrl(entry.nativeFeed), ok: false, error: cleanError(e), errorClass: classifyError(cleanError(e)).cls, discovered: (d.raw || []).some(f => normUrl(f.url) === normUrl(entry.nativeFeed)) };
        }
      }
      if (opt.stages.has('pagefeed') && !feedUrl) {
        const t = now();
        if (await robotsAllowed(entry.htmlUrl)) {
          try {
            const s = await polite(() => fetchAndSuggestFeedCandidatesDetailed(entry.htmlUrl!));
            const best = s.candidates[0];
            result.pageFeed = {
              ms: now() - t, candidates: s.candidates.length, rejected: s.rejected,
              best: best ? { score: best.score, itemCount: best.itemCount, quality: best.quality, sampleTitles: best.sampleTitles.slice(0, 3) } : null,
            };
          } catch (e) { result.pageFeed = { ms: now() - t, error: cleanError(e), errorClass: classifyError(cleanError(e)).cls }; }
        } else result.pageFeed = { skipped: 'robots-disallowed' };
      }
    }

    // ---------- health (feed entries; site entries only report what discovery validated)
    if (entry.kind === 'feed' && feedUrl && opt.stages.has('health')) {
      const health: Record<string, unknown> = {};
      const t = now();
      try {
        const feed = await polite(() => fetchFeedArticles({ url: feedUrl!, fetchTimeoutSecs: Math.ceil(opt.timeoutMs / 1000), maxSizeKb: 5120 }));
        articles = feed.articles; feedHtmlUrl = feed.htmlUrl ?? null;
        health.parseOk = true;
        health.feedTitle = feed.title;
      } catch (e) {
        const msg = cleanError(e);
        health.parseOk = false; health.error = msg; health.errorClass = classifyError(msg).cls; health.status = classifyError(msg).status;
      }
      health.parseMs = now() - t;
      // Second, metadata-only request through the same SSRF-safe fetch: status, final URL, size, type.
      try {
        const r = await polite(() => ssrf.fetchWithSsrfProtection(feedUrl!, { headers: { 'User-Agent': BENCH_UA, Accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*' } }, { timeoutMs: opt.timeoutMs, maxBytes: 5 * 1024 * 1024 }));
        if (!r.notModified) {
          health.status = r.status; health.finalUrl = maskUrl(r.url); health.bytes = Buffer.byteLength(r.text);
          health.contentType = r.headers?.get('content-type') ?? null;
          health.redirected = !!r.url && normUrl(r.url) !== normUrl(feedUrl);
          health.schemeOrHostChanged = !!r.url && r.url !== feedUrl;
          await cacheWrite('feeds', feedUrl, r.text, { finalUrl: maskUrl(r.url), status: r.status, contentType: health.contentType });
          if (health.schemeOrHostChanged) {
            try { await polite(() => ssrf.safeFetch(feedUrl!, { headers: { 'User-Agent': BENCH_UA } }, { timeoutMs: opt.timeoutMs })); }
            catch (e) { if (e instanceof ssrf.FetchRedirectError) health.redirectStatus = e.status; }
          }
        }
      } catch (e) {
        const msg = cleanError(e);
        health.metaError = msg;
        health.status ??= classifyError(msg).status;
        health.errorClass ??= classifyError(msg).cls;
      }
      if (articles.length) {
        const dates = articles.map(a => a.publishedAt ? new Date(a.publishedAt).getTime() : NaN).filter(Number.isFinite);
        const newest = dates.length ? Math.max(...dates.filter(d => d <= now() + 86_400_000)) : null;
        const lens = articles.map(a => plainText(a.content || a.summary || '').length);
        health.items = articles.length;
        health.newestAgeDays = newest && Number.isFinite(newest) ? Number(((now() - newest) / 86_400_000).toFixed(1)) : null;
        health.withDate = dates.length; health.withLink = articles.filter(a => /^https?:\/\//.test(a.link || '')).length;
        health.withImage = articles.filter(a => a.imageUrl).length;
        health.contentMedianChars = median(lens); health.contentMaxChars = Math.max(...lens);
        health.teaserFeed = (median(lens) ?? 0) < 500;
      } else if (health.parseOk) health.items = 0;
      health.verdict = !health.parseOk ? 'broken' : !articles.length ? 'empty'
        : health.newestAgeDays == null ? 'ok-undated' : (health.newestAgeDays as number) > 180 ? 'dead-stale' : (health.newestAgeDays as number) > 30 ? 'stale' : 'ok';
      result.health = health;
    }

    // ---------- discovery from the homepage + bare domain (feed entries)
    if (entry.kind === 'feed' && opt.stages.has('discovery') && feedUrl) {
      const finalFeed = (result.health as { finalUrl?: string } | undefined)?.finalUrl;
      const targets = new Set(normUrl(feedUrl) && finalFeed ? [normUrl(feedUrl), normUrl(finalFeed)] : [normUrl(feedUrl)]);
      let page = entry.htmlUrl || feedHtmlUrl || '';
      try { if (!page || !/^https?:/.test(page)) page = new URL(feedUrl).origin + '/'; } catch { /* keep */ }
      const homeHost = hostOf(page) || hostOf(feedUrl);
      const bare = bareHost(homeHost);
      const runs: Record<string, unknown> = {};
      for (const [label, input] of [['htmlUrl', page], ['bareDomain', bare]] as const) {
        if (label === 'bareDomain' && normUrl(page) === normUrl(`https://${bare}/`)) { runs[label] = { sameAs: 'htmlUrl' }; continue; }
        const d = await discoveryRun(input);
        const raw = d.raw || [];
        const idx = raw.findIndex(f => targets.has(normUrl(f.url)));
        // Different URL, same feed (feeds.x/index vs x/feed): compare item links of the top candidate.
        let equivalent: { url?: string; overlap: number } | null = null;
        if (idx < 0 && raw.length && articles.length) {
          try {
            const top = await polite(() => fetchFeedArticles({ url: raw[0].url, sourceType: raw[0].type === 'json' ? 'JSONFeed' : 'RSS', fetchTimeoutSecs: Math.ceil(opt.timeoutMs / 1000), maxSizeKb: 5120 }));
            const mine = new Set(articles.map(a => normUrl(a.link)));
            const overlap = top.articles.length ? top.articles.filter(a => mine.has(normUrl(a.link))).length / Math.min(top.articles.length, mine.size) : 0;
            equivalent = { url: maskUrl(raw[0].url), overlap: Number(overlap.toFixed(2)) };
          } catch { equivalent = { url: maskUrl(raw[0].url), overlap: 0 }; }
        }
        runs[label] = {
          ...stripRaw(d), found: idx >= 0, rank: idx >= 0 ? idx + 1 : null,
          matchSource: idx >= 0 ? raw[idx].source : null, matchPlatform: idx >= 0 ? raw[idx].platform : null,
          anyFeed: raw.length > 0, equivalent, foundEquivalent: idx >= 0 || (equivalent?.overlap ?? 0) >= 0.5,
        };
      }
      result.discovery = { page: maskUrl(page), bare, ...runs };
      result.radarRoutes = matchRadarRules(page).map(r => r.route);
    }

    // ---------- homepage AI prompt dry-run (proposeAiFeedConfig input, R3)
    if (opt.stages.has('ai-dryrun')) {
      const page = entry.kind === 'site' ? entry.htmlUrl : (result.discovery as { page?: string } | undefined)?.page;
      if (page && await robotsAllowed(page)) {
        try {
          // Same fetch profile as proposeAiFeedConfig (impit, 2 MiB, 5 redirects, 12 s).
          const html = await polite(() => ssrf.fetchTextWithSsrfProtection(page, {}, { context: 'AI feed config', impersonate: true, maxBytes: 2 * 1024 * 1024, maxRedirects: 5, timeoutMs: 12_000 }));
          await cacheWrite('pages', page, html, { role: 'homepage' });
          const prompt = buildFeedConfigPrompt(html, page);
          const bodyAt = html.search(/<body\b/i);
          const feedHref = [...html.matchAll(/href=["']([^"']*(?:rss|atom|feed)[^"']*)["']/gi)].map(m => m[1])[0];
          result.aiFeedConfigPrompt = {
            pageBytes: Buffer.byteLength(html), promptChars: prompt.length,
            headBytes: bodyAt >= 0 ? bodyAt : null,
            bodyInPrompt: /<body\b|<main\b|<article\b/i.test(prompt),
            feedLinkInPage: !!feedHref, feedLinkInPrompt: !!feedHref && prompt.includes(feedHref),
          };
        } catch (e) { result.aiFeedConfigPrompt = { error: cleanError(e), errorClass: classifyError(cleanError(e)).cls }; }
      }
    }

    // ---------- full-text for the N newest items
    if (opt.stages.has('fulltext') && articles.length) {
      const picks = [...articles]
        .filter(a => /^https?:\/\//.test(a.link || ''))
        .sort((a, b) => (b.publishedAt ? new Date(b.publishedAt).getTime() : 0) - (a.publishedAt ? new Date(a.publishedAt).getTime() : 0))
        .slice(0, opt.articles);
      const fulltext: Record<string, unknown>[] = [];
      const duplicateIndex = new RecentFullTextIndex();
      const sampledCandidates = new Map<string, { baseline: string; html: string }>();
      const escalationBudget = { ai: 0, hosted: 0, render: opt.render ? 3 : 0 };
      for (const a of picks) {
        const item: Record<string, unknown> = { link: maskUrl(a.link), host: hostOf(a.link) };
        if (!(await robotsAllowed(a.link))) { fulltext.push({ ...item, verdict: 'skipped', reason: 'robots-disallowed' }); continue; }
        const attempt = async () => {
          const t = now();
          try {
            let pageHtml: string | undefined;
            const baseline = a.content || a.summary || '';
            const ext = await polite(() => fetchAndExtractReadable(a.link, {
              onFetchedPage: (html) => { pageHtml = html ?? undefined; },
              baselineHtml: baseline, gate: 'auto', selector: entry.fullTextSelector,
              removeSelectors: entry.fullTextRemoveSelectors,
              escalationBudget,
            }));
            let decision = decideFullText(ext.quality, baseline, 'auto', ext.html);
            if (ext.html && decision.accept) {
              const duplicates = duplicateIndex.observe(a.link, a.link, ext.html).filter(link => {
                const previous = sampledCandidates.get(link);
                return previous && baselinesDiffer(baseline, previous.baseline);
              });
              if (duplicates.length) {
                decision = { accept: false, reason: 'duplicate_across_items' };
                for (const link of duplicates) {
                  const previous = sampledCandidates.get(link)!;
                  const coverage = leadCoverage(previous.baseline, previous.html);
                  if ((coverage === null && duplicates.length >= 2) || (coverage !== null && coverage < 0.3)) {
                    for (const row of fulltext) if (row.link === maskUrl(link)) { row.verdict = 'fail'; row.reason = 'duplicate_across_items'; }
                  }
                }
              }
              sampledCandidates.set(a.link, { baseline, html: ext.html });
            }
            const diagnostics = scoreExtraction(baseline, ext.html, pageHtml || '');
            return { html: pageHtml, extHtml: ext.html, finalUrl: a.link,
              status: undefined as number | undefined, ms: now() - t, extractedBy: ext.extractedBy,
              words: ext.wordCount, images: ((ext.html || '').match(/<img\b/gi) || []).length,
              ...diagnostics, verdict: decision.accept ? 'good' as const : 'fail' as const,
              reason: decision.reason, budgetSkipped: ext.budgetSkipped, parseAborted: ext.parseAborted };
          } catch (e) {
            const msg = cleanError(e); const c = classifyError(msg);
            return { ms: now() - t, error: msg, status: c.status, verdict: 'fail' as const, reason: c.status ? (c.status === 404 || c.status === 410 ? `http-${c.status}` : [401, 402, 403, 429, 451].includes(c.status) ? `blocked-http-${c.status}` : `http-${c.status}`) : `fetch-${c.cls}` };
          }
        };
        const primary = await attempt();
        const { html: pageHtml, extHtml, ...primaryOut } = primary as typeof primary & { html?: string; extHtml?: string | null };
        if (pageHtml) await cacheWrite('articles', a.link, pageHtml, { finalUrl: maskUrl((primary as { finalUrl?: string }).finalUrl), status: primary.status, transport: 'app-chain' });
        Object.assign(item, primaryOut, { finalUrl: maskUrl((primary as { finalUrl?: string }).finalUrl), transport: 'app-chain' });
        item.appChainEscalates = primary.verdict !== 'good';
        item.qualityGateWouldEscalate = primary.verdict !== 'good';
        if (opt.stages.has('ai-dryrun') && pageHtml) {
          const prompt = buildExtractionPrompt(pageHtml, a.link);
          // Does the 8K-prefix prompt contain article body text? Probe with sentences from the
          // middle of a good extract (or the feed item when the extract is unusable).
          const extS = primary.verdict === 'good' ? sentences(plainText(extHtml)) : [];
          const ref = extS.length >= 4 ? extS.slice(1, 4) : sentences(plainText(a.content || a.summary || '')).slice(0, 3);
          const promptNorm = normWords(plainText(prompt));
          item.aiPromptHasArticle = ref.length ? ref.some(s => promptNorm.includes(normWords(s).split(' ').slice(0, 8).join(' '))) : null;
          item.aiPromptChars = prompt.length;
        }
        if (opt.ai && process.env.BENCH_AI_PROVIDER && pageHtml && primary.verdict !== 'good') {
          item.ai = await runLiveAi(pageHtml, a.link, a.content || a.summary || '');
        }
        fulltext.push(item);
      }
      result.fulltext = fulltext;
    }
    result.requests = requests;
  } catch (e) {
    errors.push(cleanError(e));
  } finally {
    result.errors = errors;
    result.elapsedMs = now() - started;
    process.send?.(result);
    await db.$disconnect().catch(() => undefined);
    process.exit(0);
  }

  async function runLiveAi(html: string, url: string, feedHtml: string) {
    // Live AI only with --ai and BENCH_AI_PROVIDER/BENCH_AI_API_KEY/BENCH_AI_MODEL (never logged).
    const { extractArticleWithAi } = await import('../../lib/ai-extraction');
    const user = await db.user.upsert({ where: { email: 'bench@feedferret.invalid' }, update: {}, create: { email: 'bench@feedferret.invalid', name: 'bench' } });
    const t = now();
    const out = await polite(() => extractArticleWithAi(html, url, {
      provider: process.env.BENCH_AI_PROVIDER as import('../../lib/ai-summary').AiProvider,
      apiKey: process.env.BENCH_AI_API_KEY || null, model: process.env.BENCH_AI_MODEL || null,
      ollamaBaseUrl: process.env.BENCH_AI_OLLAMA_URL || null,
      usage: { userId: user.id, feature: 'extraction' as import('../../lib/ai/usage').AiFeature },
    }));
    if (!out) return { ms: now() - t, verdict: 'fail', reason: 'ai-empty' };
    const md = out.content;
    const sc = scoreExtraction(feedHtml, `<p>${md.replace(/\n{2,}/g, '</p><p>')}</p>`, html);
    const sourceText = normWords(plainText(html));
    const sents = sentences(md);
    const grounded = sents.length ? sents.filter(s => sourceText.includes(normWords(s).split(' ').slice(0, 8).join(' '))).length / sents.length : 0;
    return { ms: now() - t, verdict: sc.verdict, reason: sc.reason, extractedChars: sc.extractedChars, grounding: Number(grounded.toFixed(2)) };
  }
}

// ---------------------------------------------------------------- summary
type R = Record<string, any>;

function countBy<T>(xs: T[], key: (x: T) => string | undefined | null) {
  const m = new Map<string, number>();
  for (const x of xs) { const k = key(x); if (k) m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
const rate = (n: number, d: number) => (d ? `${n}/${d} (${Math.round((n / d) * 100)} %)` : '0/0');
const table = (head: string[], rows: (string | number | null | undefined)[][]) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.map(c => String(c ?? '–').replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n');

export function buildSummary(results: R[], meta: R): string {
  const live = results.filter(r => !r.placeholder);
  const feeds = live.filter(r => r.kind === 'feed');
  const sites = live.filter(r => r.kind === 'site');
  const out: string[] = [];
  out.push(`# bench-opml summary\n`);
  out.push(`Recorded ${meta.recordedAt} · base ${meta.base ?? '?'} · ${results.length} entries (${feeds.length} feeds, ${sites.length} sites, ${results.length - live.length} placeholders) · stages ${meta.stages} · articles/feed ${meta.articles} · helpers: RSSHub ${meta.helpers?.rsshub ? 'on' : 'off'}, render ${meta.helpers?.renderSidecar ? 'on' : 'off'}, AI ${meta.helpers?.ai ? 'on' : 'off'}\n`);

  out.push(`## Inputs\n`);
  out.push(table(['source list', 'entries'], countBy(results.flatMap(r => r.sources.map((s: string) => ({ s }))), x => x.s)));

  // Health
  const h = feeds.filter(r => r.health);
  out.push(`\n## Feed health (${h.length} feeds)\n`);
  out.push(table(['verdict', 'count'], countBy(h, r => r.health.verdict)));
  out.push(`\nBroken by error class:\n`);
  out.push(table(['class', 'count'], countBy(h.filter(r => r.health.verdict === 'broken'), r => r.health.errorClass || 'unknown')));
  const parsed = h.filter(r => r.health.items > 0);
  out.push(`\n- Teaser feeds (median item text < 500 chars): ${rate(parsed.filter(r => r.health.teaserFeed).length, parsed.length)}`);
  out.push(`- Redirected feed URL (shipped URL outdated): ${rate(h.filter(r => r.health.redirected).length, h.length)}; permanent (301/308): ${h.filter(r => [301, 308].includes(r.health.redirectStatus)).length}`);
  out.push(`- Median items ${median(parsed.map(r => r.health.items))}, median newest-item age ${median(parsed.map(r => r.health.newestAgeDays as number).filter(x => x != null))} d`);

  // Discovery
  const d = feeds.filter(r => r.discovery);
  const runOf = (r: R, k: string) => (r.discovery[k]?.sameAs ? r.discovery.htmlUrl : r.discovery[k]);
  out.push(`\n## Discovery from homepage (${d.length} feeds)\n`);
  const rows: (string | number)[][] = [];
  for (const k of ['htmlUrl', 'bareDomain']) {
    const runs = d.map(r => runOf(r, k)).filter(x => x && !x.skipped);
    const ms = runs.map(x => x.ms).filter((x: unknown) => typeof x === 'number');
    rows.push([k, rate(runs.filter(x => x.found).length, runs.length), rate(runs.filter(x => x.foundEquivalent).length, runs.length), rate(runs.filter(x => x.rank === 1).length, runs.length), rate(runs.filter(x => x.anyFeed).length, runs.length),
      rate(runs.filter(x => x.found && x.matchSource === 'resolver').length, runs.filter(x => x.found).length), String(median(ms)), String(pct(ms, 0.9))]);
  }
  out.push(table(['input', 'finds this feed (exact URL)', 'finds it or same-content feed', 'rank 1', 'any feed', 'found only via resolver/publisher', 'p50 ms', 'p90 ms'], rows));
  const either = d.filter(r => runOf(r, 'htmlUrl')?.found || runOf(r, 'bareDomain')?.found).length;
  const eitherEq = d.filter(r => runOf(r, 'htmlUrl')?.foundEquivalent || runOf(r, 'bareDomain')?.foundEquivalent).length;
  out.push(`\n- Either input finds the shipped feed: exact ${rate(either, d.length)}, incl. same-content feed ${rate(eitherEq, d.length)}`);
  out.push(`- Duplicate candidates (same feed listed twice): ${d.filter(r => (runOf(r, 'htmlUrl')?.duplicates || 0) > 0).length} homepages`);
  out.push(`- Discovery hints: ${countBy(d, r => runOf(r, 'htmlUrl')?.hint).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);

  // Sites
  if (sites.length) {
    out.push(`\n## Sites without a known feed (${sites.length})\n`);
    out.push(table(['category', 'sites', 'feed via discovery', 'page-feed candidate', 'native endpoint ok', 'RSSHub route'],
      countBy(sites, r => r.category).map(([cat]) => {
        const s = sites.filter(r => r.category === cat);
        const pf = s.filter(r => !r.siteDiscovery?.feedFound);
        return [cat, s.length, rate(s.filter(r => r.siteDiscovery?.feedFound).length, s.length), rate(pf.filter(r => r.pageFeed?.candidates > 0).length, pf.length),
          rate(s.filter(r => r.nativeFeed?.ok).length, s.filter(r => r.nativeFeed).length), s.filter(r => r.radarRoutes?.length).length];
      })));
  }

  // Full-text
  const ft = live.flatMap(r => (r.fulltext || []).map((a: R) => ({ ...a, entry: r.id, sources: r.sources })));
  const tested = ft.filter(a => a.verdict !== 'skipped');
  out.push(`\n## Full-text (${tested.length} articles from ${live.filter(r => r.fulltext?.length).length} feeds; ${ft.length - tested.length} robots-skipped)\n`);
  out.push(table(['verdict', 'count'], countBy(tested, a => a.verdict).map(([k, v]) => [k, rate(v, tested.length)])));
  out.push(`\nReasons:\n`);
  out.push(table(['verdict', 'reason', 'count'], countBy(tested, a => `${a.verdict}\u0000${a.reason}`).map(([k, v]) => [...k.split('\u0000'), v])));
  out.push(`\nWinning extractor (extractedBy) by verdict:\n`);
  out.push(table(['extractedBy', 'good', 'partial', 'fail'], countBy(tested.filter(a => a.extractedBy), a => a.extractedBy).map(([k]) =>
    [k, ...(['good', 'partial', 'fail'] as const).map(v => tested.filter(a => a.extractedBy === k && a.verdict === v).length)])));
  const fb = tested.filter(a => a.undiciFallback);
  out.push(`\n- Transport fallback (impit→undici) tried ${fb.length}×, improved verdict ${fb.filter(a => a.transportFallbackHelps).length}×`);
  out.push(`- App chain did not produce accepted full text: ${rate(tested.filter(a => a.appChainEscalates).length, tested.length)}; a quality gate (verdict ≠ good) would escalate: ${rate(tested.filter(a => a.qualityGateWouldEscalate).length, tested.length)}`);
  out.push(`- Pages with lazy images (data-src…): ${tested.filter(a => a.lazyImgsInPage > 0).length}; of those extracts with 0 images: ${tested.filter(a => a.lazyImgsInPage > 0 && a.images === 0).length}`);
  const ai = tested.filter(a => a.aiPromptHasArticle != null);
  out.push(`- AI extraction prompt (8K prefix) contains article text: ${rate(ai.filter(a => a.aiPromptHasArticle).length, ai.length)}`);
  const hp = live.filter(r => r.aiFeedConfigPrompt && !r.aiFeedConfigPrompt.error);
  out.push(`- AI feed-config prompt: body markup present ${rate(hp.filter(r => r.aiFeedConfigPrompt.bodyInPrompt).length, hp.length)}; page has feed link and prompt contains it ${rate(hp.filter(r => r.aiFeedConfigPrompt.feedLinkInPrompt).length, hp.filter(r => r.aiFeedConfigPrompt.feedLinkInPage).length)}`);

  // Top failing hosts
  out.push(`\n## Top failing hosts (full-text fail/partial)\n`);
  out.push(table(['host', 'fail', 'partial', 'tested', 'main reason'], countBy(tested.filter(a => a.verdict !== 'good'), a => a.host).slice(0, 25).map(([host]) => {
    const xs = tested.filter(a => a.host === host);
    return [host, xs.filter(a => a.verdict === 'fail').length, xs.filter(a => a.verdict === 'partial').length, xs.length, countBy(xs.filter(a => a.verdict !== 'good'), a => a.reason)[0]?.[0]];
  })));

  // Broken shipped entries
  out.push(`\n## Shipped list entries needing attention\n`);
  const bad = feeds.filter(r => r.health && !['ok', 'ok-undated'].includes(r.health.verdict) || r.health?.redirected);
  out.push(table(['source', 'feed', 'verdict', 'detail'], bad.sort((a, b) => a.sources[0].localeCompare(b.sources[0])).map(r => [r.sources.join(', '), r.feedUrl, r.health.verdict,
    r.health.verdict === 'broken' ? `${r.health.errorClass}${r.health.status ? ' ' + r.health.status : ''}` : r.health.verdict.includes('stale') ? `newest ${r.health.newestAgeDays} d` : r.health.redirected ? `→ ${r.health.finalUrl}${r.health.redirectStatus ? ' (' + r.health.redirectStatus + ')' : ''}` : ''])));
  const ph = results.filter(r => r.placeholder);
  if (ph.length) out.push(`\nPlaceholders not fetched: ${ph.map(r => `${r.feedUrl || r.htmlUrl} (${r.placeholder})`).join('; ')}`);
  return out.join('\n') + '\n';
}

export function buildPlatformMatrix(results: R[]): string | null {
  const p = results.filter(r => r.sources?.includes('platforms'));
  if (!p.length) return null;
  const cap = (r: R) => {
    const disc = r.siteDiscovery?.feedFound ? (r.siteDiscovery.via?.source === 'resolver' ? `✅ resolver (${r.siteDiscovery.via.platform || '?'})` : `✅ ${r.siteDiscovery.via?.source || 'html'}`) : `❌${r.siteDiscovery?.hint ? ' ' + r.siteDiscovery.hint : ''}${r.siteDiscovery?.count ? ` (${r.siteDiscovery.count} unvalidated)` : ''}`;
    const native = r.nativeFeed ? (r.nativeFeed.ok ? `✅ ${r.nativeFeed.items} items${r.nativeFeed.discovered ? '' : ' (not discovered)'}` : `❌ ${r.nativeFeed.errorClass || 'empty'}`) : '–';
    const radar = r.radarRoutes?.length ? `route ${r.radarRoutes[0]}` : '–';
    const pf = r.siteDiscovery?.feedFound ? 'n/a' : r.pageFeed?.skipped ? r.pageFeed.skipped : r.pageFeed?.error ? `❌ ${r.pageFeed.errorClass}` : r.pageFeed?.candidates ? `✅ ${r.pageFeed.best?.itemCount} items (${r.pageFeed.best?.quality?.verdict ?? r.pageFeed.best?.quality?.status ?? 'q?'})` : '❌ none';
    const best = r.siteDiscovery?.feedFound ? 'discovery' : r.nativeFeed?.ok ? 'native (adapter needed)' : r.radarRoutes?.length ? 'RSSHub' : r.pageFeed?.candidates ? 'page-feed' : 'none';
    return [r.platform, r.id.replace(/^plat-/, ''), r.htmlUrl, disc, native, radar, pf, best];
  };
  return [
    `# Platform coverage matrix (current main)\n`,
    `Discovery = \`discoverFeeds(url)\` + validation of the first 3 candidates with \`fetchFeedArticles\`. Native = known public endpoint fetched with \`fetchFeedArticles\` ("not discovered" = endpoint works but current discovery does not return it). RSSHub = \`matchRadarRules\` route (RSSHub itself not configured in this run). Page-feed = \`fetchAndSuggestFeedCandidatesDetailed\`, only when discovery found nothing.\n`,
    table(['platform', 'case', 'url', 'discovery', 'native feed', 'RSSHub', 'page-feed', 'best path today'], p.map(cap)),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- parent
async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const multi = (name: string) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
  const self = fileURLToPath(import.meta.url);
  const root = path.resolve(path.dirname(self), '../..');

  if (args.includes('--worker')) {
    const payload = JSON.parse(flag('--worker', '{}')) as { entry: Entry; opt: Omit<Options, 'stages'> & { stages: string[] } };
    await runWorker(payload.entry, { ...payload.opt, stages: new Set(payload.opt.stages) });
    return;
  }
  const out = path.resolve(flag('--out', 'bench-out'));
  if (args.includes('--summarize')) {
    const lines = (await readFile(path.join(out, 'results.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
    const meta = JSON.parse(await readFile(path.join(out, 'meta.json'), 'utf8').catch(() => '{}'));
    await writeFile(path.join(out, 'summary.md'), buildSummary(lines, meta));
    const pm = buildPlatformMatrix(lines);
    if (pm) await writeFile(path.join(out, 'PLATFORMS.md'), pm);
    console.log(`summary written to ${out}`);
    return;
  }
  if (process.env.CI && !['', '0', 'false'].includes(process.env.CI.toLowerCase()) && !args.includes('--allow-ci')) {
    throw new Error('bench-opml refuses to run in CI (CI is set); pass --allow-ci to override deliberately');
  }
  if (!args.includes('--live')) throw new Error('Pass --live to authorize public network requests (offline replay is not implemented; use --summarize to rebuild reports)');

  const stages = new Set(flag('--stages', ALL_STAGES.join(',')).split(',').map(s => s.trim()).filter(Boolean));
  for (const s of stages) if (!ALL_STAGES.includes(s)) throw new Error(`Unknown stage ${s}`);
  const opt: Options = {
    stages,
    articles: Number(flag('--articles-per-feed', '3')),
    delayMs: Number(flag('--delay-ms', '1000')),
    timeoutMs: Number(flag('--timeout-ms', '20000')),
    workerTimeoutMs: Number(flag('--worker-timeout-ms', '300000')),
    cacheDir: path.resolve(flag('--cache-dir', path.join(out, 'cache'))),
    snapshot: !args.includes('--no-snapshot'),
    robots: !args.includes('--ignore-robots'),
    render: args.includes('--render'),
    rsshub: args.includes('--rsshub'),
    ai: args.includes('--ai'),
  };
  const concurrency = Math.max(1, Math.min(8, Number(flag('--concurrency', '4'))));

  // Inputs
  const raw: Entry[] = [];
  if (args.includes('--bundled')) raw.push(...await collectBundled(root));
  for (const f of multi('--opml')) raw.push(...await readOpmlEntries(path.resolve(f), path.basename(f)));
  for (const f of multi('--sites')) raw.push(...await readSitesJson(path.resolve(f), path.basename(f)));
  let entries = finalizeEntries(raw);
  const only = flag('--only', '');
  if (only) { const re = new RegExp(only, 'i'); entries = entries.filter(e => re.test(`${e.id} ${e.feedUrl || ''} ${e.htmlUrl || ''} ${e.sources.join(' ')}`)); }
  const limit = Number(flag('--limit', '0'));
  if (limit > 0) entries = entries.slice(0, limit);
  if (!entries.length) throw new Error('No inputs: pass --bundled, --opml <file> or --sites <file>');

  await mkdir(out, { recursive: true });
  await mkdir(opt.cacheDir, { recursive: true });
  const resultsFile = path.join(out, 'results.jsonl');
  const done = new Set<string>();
  if (args.includes('--resume') && existsSync(resultsFile)) {
    for (const l of (await readFile(resultsFile, 'utf8')).split('\n').filter(Boolean)) done.add(JSON.parse(l).id);
  } else await writeFile(resultsFile, '');

  // Fresh SQLite DB with the current schema (never a real user DB).
  const dbFile = path.join(opt.cacheDir, 'bench.db');
  const dbUrl = `file:${dbFile}`;
  if (!existsSync(dbFile)) {
    const r = spawnSync('pnpm', ['run', '-s', 'prisma:push'], { cwd: root, env: { ...process.env, DATABASE_PROVIDER: 'sqlite', DATABASE_URL: dbUrl }, stdio: 'ignore' });
    if (r.status !== 0) throw new Error('prisma:push for the bench DB failed');
  }
  let base = '';
  try { base = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).stdout.toString().trim(); } catch { /* ignore */ }
  const meta: R = { recordedAt: new Date().toISOString(), base, stages: [...stages].join(','), articles: opt.articles, delayMs: opt.delayMs, concurrency, entries: entries.length, helpers: { rsshub: opt.rsshub, renderSidecar: opt.render, ai: opt.ai && !!process.env.BENCH_AI_PROVIDER } };
  await writeFile(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));

  // Placeholders are reported, never fetched.
  for (const e of entries.filter(x => x.placeholder && !done.has(x.id))) {
    await appendFile(resultsFile, JSON.stringify({ id: e.id, kind: e.kind, sources: e.sources, feedUrl: maskUrl(e.feedUrl), htmlUrl: maskUrl(e.htmlUrl), placeholder: e.placeholder }) + '\n');
    done.add(e.id);
  }

  // Scheduler: global concurrency, never two running entries sharing a host, delay per host.
  const queue = entries.filter(e => !done.has(e.id));
  const hostsOf = (e: Entry) => [...new Set([hostOf(e.feedUrl), hostOf(e.htmlUrl), hostOf(e.nativeFeed)].filter(Boolean).map(bareHost))];
  const busy = new Set<string>();
  const lastDone = new Map<string, number>();
  let running = 0, finished = 0;
  const total = queue.length;
  await new Promise<void>(resolveAll => {
    const pump = () => {
      if (!queue.length && running === 0) return resolveAll();
      while (running < concurrency) {
        const t = now();
        const idx = queue.findIndex(e => hostsOf(e).every(h => !busy.has(h) && t - (lastDone.get(h) || 0) >= opt.delayMs));
        if (idx < 0) break;
        const [e] = queue.splice(idx, 1);
        const hs = hostsOf(e);
        hs.forEach(h => busy.add(h));
        running++;
        runEntry(e).then(async r => {
          await appendFile(resultsFile, JSON.stringify(r) + '\n');
          finished++;
          const ft = (r.fulltext as R[] | undefined) || [];
          console.log(`[${finished}/${total}] ${e.id} ${(r.health as R | undefined)?.verdict ?? ((r.siteDiscovery as R | undefined)?.feedFound ? 'feed-found' : 'site')} ft=${ft.map(a => a.verdict[0]).join('')} ${Math.round(Number(r.elapsedMs) / 1000)}s`);
        }).finally(() => {
          hs.forEach(h => { busy.delete(h); lastDone.set(h, now()); });
          running--;
          pump();
        });
      }
      if (queue.length && running < concurrency) setTimeout(pump, 250);
    };
    pump();
  });

  function runEntry(entry: Entry): Promise<R> {
    return new Promise(resolve => {
      let settled = false;
      const t = now();
      const child = fork(self, ['--worker', JSON.stringify({ entry, opt: { ...opt, stages: [...opt.stages] } })], {
        execArgv: process.execArgv,
        env: { ...process.env, DATABASE_PROVIDER: 'sqlite', DATABASE_URL: dbUrl },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const finish = (value: R) => { if (settled) return; settled = true; clearTimeout(timer); child.kill('SIGKILL'); resolve(value); };
      const base = { id: entry.id, kind: entry.kind, sources: entry.sources, feedUrl: maskUrl(entry.feedUrl), htmlUrl: maskUrl(entry.htmlUrl), category: entry.category, platform: entry.platform };
      const timer = setTimeout(() => finish({ ...base, elapsedMs: now() - t, errors: ['worker deadline exceeded; pending requests killed'], timedOut: true }), opt.workerTimeoutMs);
      child.on('message', m => finish(m as R));
      child.on('error', err => finish({ ...base, elapsedMs: now() - t, errors: [cleanError(err)] }));
      child.on('exit', (code, signal) => finish({ ...base, elapsedMs: now() - t, errors: [`worker exited without result (code=${code}, signal=${signal})`] }));
    });
  }

  const lines = (await readFile(resultsFile, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  await writeFile(path.join(out, 'summary.md'), buildSummary(lines, meta));
  const pm = buildPlatformMatrix(lines);
  if (pm) await writeFile(path.join(out, 'PLATFORMS.md'), pm);
  console.log(`done: ${lines.length} results → ${out}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Benchmark failed');
  process.exitCode = 1;
});
