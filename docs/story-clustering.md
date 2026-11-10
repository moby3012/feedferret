# Story clustering (K1, no-AI tier)

Groups articles of **different feeds** that cover the same story (per user, last 48 h). No AI, no network, no new dependencies — pure TypeScript in `lib/story-clustering/`.

| | |
|---|---|
| Disable globally | `DISABLE_STORY_CLUSTERING=true` (job is a no-op) |
| Disable per user | `User.storyClustering = false` |
| Read semantics | `User.clusterReadMode`: `"story"` (default) — marking a story's **lead** read marks its other unread sources read; `"article"` — only that row |
| Window / size | 48 h, ≤ 50 sources per cluster, never two articles of one feed in one cluster |

## Data

- `StoryCluster` (per user): `leadArticleId`, `size`, `feedCount`, `firstSeenAt`, `lastSeenAt`, `sig` (JSON ≤ 2 KB), `algoVersion`. Singletons get **no** row.
- `Article` (all nullable): `clusterId`, `storySig` (JSON ≤ 600 chars), `clusteredAt` (null = pending; set once processed, also for singletons).
- Additive only (works with `prisma db push` on Postgres). Indexes: `(userId, clusterId)`, `(userId, clusteredAt, publishedAt)`, `StoryCluster(userId, lastSeenAt)`.

## Algorithm (`similarity.ts`, constants in `CONFIG`)

1. **Signature** (`normalize.ts`): strip site suffix (`- SPIEGEL`, `| tagesschau.de`) and format prefixes (`Eilmeldung:`), fold (NFKC, lowercase, `ß→ss`, umlauts), tokenize (stopwords de/en, numbers incl. `0,25` and `CVE-…` as one token, light stemmer, newsroom-verb synonyms such as `beschließt ≈ stimmt für ≈ verabschiedet`, alias table `EZB ≡ Europäische Zentralbank`, `Fed ≡ Federal Reserve`), entities by heuristics (ACRONYMS, `A19`, decimals, `iPhone 17 → iphone17`, CamelCase, capitalized words for English), outbound link hashes. Excluded: live blogs, newsletters, < 3 tokens, hidden feeds, duplicates.
2. **Pair score** (different feeds, ≤ 48 h apart): `0.30·W + 0.30·A + 0.40·C + 0.15·E + 0.25·L − 0.20·conflict − 0.10·[Δt > 36 h]` with W = idf-weighted ½ Jaccard + ½ overlap, A = saturating shared-idf mass, C = char-trigram Jaccard, E = shared entities (one shared entity = half credit), L = shared outbound link, conflict = both name entities, none shared, one is an identity entity (acronym/number/brand). Gate: ≥ 2 shared *strong* tokens (generic verbs/years are weak), or link + 1 token, or ≥ 2 shared entities. Join ≥ **0.53**.
3. **Assignment** (`engine.ts`): pending oldest first; candidates via inverted index (token/entity/link, ≤ 200); best target per cluster/singleton; **drift guard** (joiner must score ≥ 0.35 against the cluster's *lead*); size cap 50; ties → older cluster. Deterministic and order-independent; no merges/splits (algoVersion bump + re-run is the repair path).
4. **Job** (`job.ts`): per user, ≤ 200 pending (published ≤ 48 h) per round, steps of 50 with a yield + budget check between them; claim = `updateMany where clusteredAt is null` (idempotent, multi-instance safe; lost claims trigger a recount). `runStoryClustering({budgetMs: 400})` runs after each sync tick and never blocks or fails it; leftovers (first-run 48 h backfill, bursts) are drained by `drainStoryClustering` (further ≤ 400 ms passes, 1.5 s apart, single-flight). Daily `cleanupStoryClusters` (next to retention) drops clusters older than 14 d or without members.

## API (for the cluster-card UI)

- `GET /api/app/articles` items gain optional `clusterId`, `clusterSize`, `clusterLeadId` (only for clustered rows; nothing existing changes).
- `GET /api/app/clusters/:id` → `ClusterDetail { id, size, leadId, members: ArticleListItem[] }` (session auth, user-scoped, 404 otherwise, ≤ 100 members, oldest first).
- Server action `applyArticleStateOps` returns `{ failed, affected }`; `affected` = other sources marked read by the story cascade (user-scoped, ≤ 500, explicit ops in the same batch win). Undo = explicit `isRead:false` ops for those ids.
- Settings: `getReadingPreferences()` / `updateGlobalSettings()` expose `storyClustering` and `clusterReadMode`.

## Quality (fixtures in `tests/fixtures/`, run `STORY_REPORT=1 npx vitest run tests/lib/story-engine.test.ts`)

| set | stories | items | pairwise precision | pairwise recall | false merges |
|---|---|---|---|---|---|
| tuning (`story-headlines.json`: 12 same-story groups, 14 hard-negative groups, 102 filler) | 12 | 162 | 1.000 (28 TP / 0 FP) | 1.000 (0 FN) | 0 |
| holdout (`story-headlines-holdout.json`, written after tuning, not used for it) | +6 | 182 | 1.000 (36 TP / 0 FP) | 1.000 (0 FN) | 0 |

Score margin on the tuning set: lowest same-story pair 0.567, highest other pair 0.491 (threshold 0.53). On tuning + holdout the two ranges overlap slightly (0.472 vs 0.500): the threshold sits above every negative pair, and the one weak positive pair is still linked through a third source. Treat the fixture numbers as a regression net, not as a production precision claim; the acceptance spot check on real data (≥ 5 % clustered, 0 false merges in 50 cards) is still to do on a prod-sized copy.

## Performance (`tests/server/story-bench.test.ts`, SQLite file, Apple M-series, shared machine)

| scenario | result |
|---|---|
| incremental tick, 200 new articles vs. 5 000 in the 48 h window (reads + engine + writes) | **133–146 ms** (median of 3 ticks; one noisy run 391 ms) — budget 400 ms |
| pure engine, 200 pending vs. 5 000 window | **~25 ms** median (idf + index build included) |
| first-run backfill of the 5 000-article window | 25 rounds, **~2.6 s** total, slowest round ~150 ms |
| queries per round | 1 (pending) + 1 (bodies, only for rows without signature) + 2 (window, clusters) + ⌈writes/100⌉ transactions |

CI runs the same test with 4× slack. Escalation if a window ever exceeds ~20k rows per user: replace the inverted-index blocking by MinHash/LSH over the same `scorePair`.
