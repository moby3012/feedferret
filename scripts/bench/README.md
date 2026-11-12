# Feed-everything live benchmark

This is an opt-in exploratory benchmark, **not a CI test**. It contacts 88 public
URLs and additional feed discovery paths. Run it manually from the repo root.
Use Node 22+, pnpm, and a disposable SQLite database with the current schema:

```sh
pnpm install --frozen-lockfile
DATABASE_PROVIDER=sqlite DATABASE_URL=file:/tmp/feedferret-t1.db pnpm run prisma:generate
DATABASE_PROVIDER=sqlite DATABASE_URL=file:/tmp/feedferret-t1.db pnpm run prisma:push
DATABASE_PROVIDER=sqlite DATABASE_URL=file:/tmp/feedferret-t1.db \
  pnpm dlx tsx@4.23.15 scripts/bench/feed-everything.mts --live \
  --output /tmp/feed-everything.results.json
```

`--only blogs-8` runs one case. `--timeout-ms 90000` sets the per-site process
budget (1–300 seconds). Output checkpoints after every site. Runtime can exceed
an hour on slow connections. Raw page bodies and connector keys are never logged.
CI environments are refused even with `--live`; no package script/test/CI job
invokes this tool. `tsx` is downloaded on demand, not added to app dependencies.

The runner executes one site at a time, waits 750 ms between sites, and caps
native fetch requests (including response reading) at three. App-owned headers,
redirect handling, response size limits, DNS checks, and SSRF protection stay in
place. Selector fetching uses the app's default impit transport, sequentially.
The benchmark does not introduce a crawler or bypass app policy. Currently these
entry points do not enforce robots.txt; this tool adds no robots bypass.

The worker strips connector environment configuration and trust overrides,
requires SQLite, and refuses an internal-fetch-enabled DB. **Use a fresh DB**:
existing DB connector configuration would still be read by the application.
RSSHub/render/BYOK services are intentionally absent in the baseline. Radar
matches are recorded as routes requiring RSSHub, not counted as successful feeds.
A missing render fallback is recorded as untested, not proof that rendering
would fix the page. Changedetection requires a configured service and two
snapshots; this runner does not create remote watches or use paid APIs.

## What the numbers mean

- Calls `discoverFeeds` from `lib/feed-discovery.ts`, the implementation behind
  authenticated `GET /api/discover`. Explicit feed URLs use `fetchFeedArticles`
  directly, as `addFeed` does. HTTP authentication and UI state are out of scope.
- Tries at most the first three candidates, then the actual
  `fetchAndSuggestFeedCandidates` implementation behind `suggestFeedFromUrl` /
  “Von Webseite”. Those are separate UI flows; this harness combines them to
  measure reachable coverage. JSON candidates use the fetcher's explicit
  `JSONFeed` mode, which is available in advanced feed configuration.
- `native-converter` is a deterministic platform-to-native-feed rule;
  `converter-RSSHub` requires a validated RSSHub route. `discovered` includes
  HTML-advertised and common-path feeds (the candidate's `source` distinguishes).
- A nonempty parse/selector preview is **technical extraction**, not proof of a
  useful feed. Review `sample`, `selected`, `selectorConfig`, and expected scope.
  Common-path feeds may be site-wide; issue URLs may resolve to releases;
  selectors may pick menus, duplicate links, or unrelated cards.
- Feed quality counts cover all parsed items. Selector quality covers only the
  returned preview (at most ten items), while `itemCount` is the full suggestion
  count. `parsedDates` measures valid normalized dates, not correct chronology.
  `images` counts presence, not reachability/absoluteness; `absoluteLinks` counts
  HTTP(S) item URLs. Long-term deduplication/refresh stability is not tested.
- `trace` records native transport statuses/errors only. impit selector requests
  are not in this trace; selector exceptions are retained in `errors`.
  Discovery itself swallows many failed probes, so an empty discovery result
  cannot reliably distinguish “no feed” from every upstream failure.
- The parent kills the worker at its deadline, terminating outstanding requests
  rather than letting Promise.race leave background crawls running. A timeout
  can discard partial work and is not evidence of permanent unsupported status.

Results are network-, region-, time-, deployment-, and URL-dependent. Use the
category expectations and manual semantic review alongside extraction rates.
Newsletter inbox ingestion is not implemented and is outside this public-URL run.

## Offline selector fixtures

`capture-page-fixtures.mts --live <id…>` fetches the given benchmark sites once
through the same SSRF-safe page transport as “Von Webseite”, trims the HTML to
what the selector heuristic reads (tags with class/id, links,
dates, image sources, text) and writes `tests/fixtures/page-feed/<id>.html`.
`tests/lib/page-feed-quality.test.ts` runs the preview quality gate against
those files fully offline. Re-capturing changes expectations; review the
fixture diff and the test table together. Selector results in the benchmark
output now carry the gate verdict (`selected.quality`: `ok`/`review` + reasons);
lists the gate rejects no longer appear as `selector` results at all.

## bench-opml: feed health, discovery and full-text over OPML / site lists

`scripts/bench-opml.mjs` (launcher) runs `scripts/bench/bench-opml.mts` under
tsx. It is the harness from the AI/feed diagnosis (§11): one structured run over
an OPML export or JSON site list that measures every feed with the app's own
functions, so the same command can be re-run after a fix to compare numbers.

```sh
pnpm install --frozen-lockfile
DATABASE_PROVIDER=sqlite DATABASE_URL=file:./dev.db pnpm run prisma:generate
# everything FeedFerret ships as examples (starter OPMLs, discovery catalog,
# publisher table, feed-everything.sites.json, platforms.sites.json, import fixture)
node scripts/bench-opml.mjs --live --bundled --out bench-out/bundled
# your own export
node scripts/bench-opml.mjs --live --opml ~/feeds.opml --out bench-out/mine
# rebuild summary.md / PLATFORMS.md from an existing results.jsonl
node scripts/bench-opml.mjs --summarize --out bench-out/mine
```

Options: `--opml <file>` / `--sites <json>` (repeatable), `--bundled`,
`--only <regex>` (id, URL or source list), `--limit N`, `--articles-per-feed 3`,
`--stages health,discovery,pagefeed,fulltext,ai-dryrun`, `--concurrency 4`,
`--delay-ms 1000`, `--timeout-ms 20000`, `--worker-timeout-ms 300000`,
`--cache-dir <dir>` (default `<out>/cache`), `--no-snapshot`, `--resume`,
`--ignore-robots`, `--render` / `--rsshub` (keep the matching
`FEEDFERRET_*` env so a configured helper is used), `--ai` (see below).
Site lists use the `feed-everything.sites.json` shape
(`{id, category, url, platform?, nativeFeed?, expectation?}`); entries with
`feedUrl`/`xmlUrl` are treated as feeds.

### What each stage calls

| stage | app functions | notes |
|---|---|---|
| health | `fetchFeedArticles` (parse, items, dates, content length) + `fetchWithSsrfProtection` (status, final URL, size, content type; one-hop `safeFetch` for the redirect status) | verdict `ok` / `ok-undated` / `stale` (>30 d) / `dead-stale` (>180 d) / `empty` / `broken` + error class |
| discovery | `discoverFeeds(htmlUrl)` and `discoverFeeds(bare domain)` | exact match after normalisation (scheme, `www.`, trailing slash) plus a same-content check: the top candidate's item links vs. the shipped feed's (≥ 50 % overlap). `matchSource: resolver` = found only through platform/publisher rules |
| sites | `discoverFeeds` → first 3 candidates validated with `fetchFeedArticles`; `nativeFeed` (if listed) fetched separately; `fetchAndSuggestFeedCandidatesDetailed` when nothing validated; `matchRadarRules` for RSSHub routes | the feed-creation path for URLs without a known feed |
| fulltext | `fetchAndExtractReadable` + `decideFullText`, with OPML `frss:cssFullContent` / `cssContentFilter` | N newest items; app transport fallback and quality gate, bounded cross-item duplicate comparison, shared render budget when `--render` is enabled |
| ai-dryrun | `buildFeedConfigPrompt` (homepage, same fetch as `proposeAiFeedConfig`), `buildExtractionPrompt` (articles) | no model call: checks whether body text / feed links reach the prompt |

The full-text verdict uses the app's storage decision: `good` means accepted;
`fail` means the feed content is kept (including an already-full feed), or fetch
failed. Reasons come from the app gate (`teaser`, `lead_mismatch`, `js_shell`,
wall/thin/empty reasons), the bounded duplicate guard (`duplicate_across_items`),
or fetch classification. Extra length/overlap/chrome metrics remain diagnostics
and do not override that decision. `appChainEscalates` and
`qualityGateWouldEscalate` are legacy output names for an unaccepted final result;
they do not count actual escalation calls. Transport fallback runs inside the
app chain, without an additional benchmark-only fetch. Each entry uses a fresh
scratch database, so comparisons cover sampled items rather than stored history.

### Outputs

- `results.jsonl` – one line per feed/site with sub-objects per article.
  No bodies, headers or keys; URL query params named like
  key/token/secret/auth/sig/session and URL userinfo are masked.
- `summary.md` – aggregate tables, failure reasons, top failing hosts, shipped
  list entries needing attention. `PLATFORMS.md` when `platforms.sites.json`
  was part of the input.
- `meta.json` – run parameters (base commit, stages, helper flags).
- `<cache-dir>/{feeds,pages,articles}/<sha1(url)>.gz` +
  `.meta.json` raw snapshots (source for the offline fixture corpus, diagnosis
  §10), `<cache-dir>/robots/`, `<cache-dir>/bench.db` (fresh SQLite, schema via
  `prisma:push`). `bench-out/` is gitignored; private OPML snapshots must not be
  copied into fixtures without review.

### Politeness and safety

- Refuses to run when `CI` is set unless `--allow-ci`; needs `--live`.
- One worker process per entry (hard-killed at `--worker-timeout-ms`). The
  scheduler never runs two entries that share a host and waits `--delay-ms`
  between entries per host; inside a worker stage calls are sequential with
  the same delay. Internal retries/escalations keep the app's own policy. App-internal parallelism (discovery verifies candidates in
  batches) is unchanged.
- robots.txt (RFC 9309 wildcards, group `*` or `feedferret`) is honoured for
  homepages and article pages: disallowed URLs are reported as
  `robots-disallowed`, not fetched. Feed URLs are fetched as a reader would.
- Extra requests (robots, health metadata) send
  `FeedFerret/1.0 (+https://github.com/moby3012/feedferret) bench-opml`;
  app calls keep the app's own headers (impit browser profile for full-text).
- Workers strip `FEEDFERRET_*` connector env and trust overrides, use only the
  throwaway SQLite DB and refuse an internal-fetch-enabled configuration.
- `--ai` (default off) calls `extractArticleWithAi` for non-good articles only
  when `BENCH_AI_PROVIDER` (+ `BENCH_AI_API_KEY`, `BENCH_AI_MODEL`,
  `BENCH_AI_OLLAMA_URL`) are set; usage is metered against a bench user in the
  scratch DB, and a grounding ratio (output sentences found in the page) is
  recorded. Keys are never written to outputs.
- Offline replay from the cache is not implemented yet; `--summarize` only
  rebuilds the reports.
