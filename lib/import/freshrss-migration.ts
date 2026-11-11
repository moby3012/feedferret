/**
 * FreshRSS → FeedFerret migration orchestration.
 *
 * Accepts what a FreshRSS user can actually download from Settings → Import/export:
 *   - the export ZIP  (`freshrss_<user>_<date>_export.zip`: `feeds_<date>.opml.xml`,
 *     `starred_<date>.json`, `feed_<date>_<cat>_<feed>.json`),
 *   - or a single OPML file, or a single article JSON file.
 *
 * Order is fixed: subscriptions (OPML) first so article origins resolve to real
 * feeds, then article JSON files (`starred_*` first, then `feed_*`). Overlap
 * between files merges (same article = same feed + guid). With `dryRun` nothing
 * is written and the same counts are returned, so the UI can show a summary and
 * ask for confirmation before the real run.
 */

import { applyOpmlImportPlan, planOpmlImport, type ImportIssue, type OpmlImportPlan, type OpmlImportReport } from "./opml-import";
import { parseOpml, OpmlParseError } from "@/lib/opml";
import { MAX_OPML_BYTES } from "@/lib/validation";
import {
  FreshRssJsonError,
  type DryRunRow,
  importFreshRssArticles,
  MAX_IMPORT_ITEMS_PER_RUN,
  mergeArticleReports,
  parseFreshRssArticleJson,
  type ArticleImportReport,
} from "./freshrss-json";
import { consumeRateLimit, peekRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { DEFAULT_ZIP_LIMITS, isZipBuffer, ZipArchive, ZipError, type ZipLimits } from "./zip-reader";

/** Maximum accepted upload (compressed) size for the migration endpoint. */
export const FRESHRSS_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

export type MigrationFileKind = "opml" | "articles" | "skipped";

export interface MigrationFileReport {
  name: string;
  kind: MigrationFileKind;
  status: "ok" | "error" | "skipped";
  /** Why a file was skipped or failed. */
  detail?: string;
  items?: number;
}

export interface MigrationProgress {
  phase: "read" | "opml" | "articles";
  file?: string;
  done: number;
  total: number;
}

export interface FreshRssMigrationReport {
  dryRun: boolean;
  source: "zip" | "opml" | "json";
  files: MigrationFileReport[];
  opml: OpmlImportReport | null;
  articles: ArticleImportReport | null;
  /** Everything adapted, preserved or not supported — never silently dropped. */
  issues: ImportIssue[];
  errors: string[];
  progress: MigrationProgress[];
}

export class MigrationInputError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "MigrationInputError";
  }
}

/**
 * A not-yet-read input file. For a ZIP only the entry reference is kept; the bytes are
 * inflated (and released again) one file at a time so peak memory is one entry, not the
 * whole archive.
 */
interface InputFile { name: string; load: () => Buffer | Promise<Buffer> }

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

function looksLikeOpml(text: string): boolean {
  return /<opml[\s>]/i.test(text.slice(0, 4096)) || /<opml[\s>]/i.test(text);
}

function classify(name: string): "opml" | "json" | null {
  const base = name.split("/").pop() ?? name;
  if (base.startsWith(".") || name.startsWith("__MACOSX/")) return null;
  const lower = base.toLowerCase();
  if (lower.endsWith(".opml") || lower.endsWith(".opml.xml") || lower.endsWith(".xml")) return "opml";
  if (lower.endsWith(".json")) return "json";
  return null;
}

function collectPlannedFeeds(plan: OpmlImportPlan, into: Map<string, { unicityCriteria: string }>) {
  const add = (feed: OpmlImportPlan["feeds"][number]) => into.set(feed.url, { unicityCriteria: feed.data.unicityCriteria });
  const walk = (categories: OpmlImportPlan["categories"]) => {
    for (const category of categories) {
      category.feeds.forEach(add);
      walk(category.children);
    }
  };
  plan.feeds.forEach(add);
  walk(plan.categories);
}

function describeZipError(error: ZipError): string {
  return `${error.message} [${error.code}]`;
}

export async function runFreshRssMigration(
  userId: string,
  upload: Buffer,
  options: { dryRun?: boolean; limits?: ZipLimits; chunkSize?: number; maxItems?: number; onProgress?: (progress: MigrationProgress) => void } = {},
): Promise<FreshRssMigrationReport> {
  const dryRun = options.dryRun === true;
  const progress = new Map<string, MigrationProgress>();
  const emit = (event: MigrationProgress) => {
    progress.set(`${event.phase}:${event.file ?? ""}`, event);
    options.onProgress?.(event);
  };

  const report: FreshRssMigrationReport = {
    dryRun,
    source: "zip",
    files: [],
    opml: null,
    articles: null,
    issues: [],
    errors: [],
    progress: [],
  };

  // 1. Name the upload's files (bounded). ZIP entries stay compressed until processed.
  const opmlFiles: InputFile[] = [];
  const jsonFiles: InputFile[] = [];

  if (isZipBuffer(upload)) {
    let archive: ZipArchive;
    try {
      archive = new ZipArchive(upload, options.limits ?? DEFAULT_ZIP_LIMITS);
    } catch (error) {
      if (error instanceof ZipError) throw new MigrationInputError(describeZipError(error));
      throw error;
    }
    for (const entry of archive.entries.filter((e) => !e.isDirectory)) {
      const kind = classify(entry.name);
      if (!kind) {
        report.files.push({ name: entry.name, kind: "skipped", status: "skipped", detail: "not an OPML or JSON file" });
        continue;
      }
      (kind === "opml" ? opmlFiles : jsonFiles).push({ name: entry.name, load: () => archive.read(entry) });
    }
  } else {
    const text = upload.toString("utf8").replace(/^\ufeff/, "").trimStart();
    if (text.startsWith("<")) {
      report.source = "opml";
      opmlFiles.push({ name: "feeds.opml", load: () => upload });
    } else if (text.startsWith("{")) {
      report.source = "json";
      jsonFiles.push({ name: "articles.json", load: () => upload });
    } else {
      throw new MigrationInputError("Unrecognised file: expected the FreshRSS export ZIP, an OPML file or an article JSON file");
    }
  }

  if (!opmlFiles.length && !jsonFiles.length) {
    throw new MigrationInputError("The archive contains no OPML or article JSON files");
  }

  // 2. Subscriptions first.
  const plannedFeeds = new Map<string, { unicityCriteria: string }>();
  const dryRunLedger = new Map<string, DryRunRow>();
  opmlFiles.sort((a, b) => a.name.localeCompare(b.name));
  let readIndex = 0;
  const totalFiles = opmlFiles.length + jsonFiles.length;
  for (const file of opmlFiles) {
    emit({ phase: "read", file: file.name, done: ++readIndex, total: totalFiles });
    await yieldToEventLoop();
    try {
      const data = await file.load();
      if (data.length > MAX_OPML_BYTES) throw new OpmlParseError(`OPML file too large (max ${MAX_OPML_BYTES / 1024 / 1024} MB)`);
      const text = data.toString("utf8");
      if (!looksLikeOpml(text)) {
        report.files.push({ name: file.name, kind: "skipped", status: "skipped", detail: "XML file without an <opml> root" });
        continue;
      }
      const plan = planOpmlImport(await parseOpml(text), { trust: "local" });
      collectPlannedFeeds(plan, plannedFeeds);
      const opml = await applyOpmlImportPlan(userId, plan, {
        dryRun,
        onProgress: (p) => emit({ ...p, file: file.name }),
      });
      report.opml = report.opml ? mergeOpmlReports(report.opml, opml) : opml;
      report.files.push({ name: file.name, kind: "opml", status: "ok", items: opml.feedsAdded + opml.feedsUpdated });
    } catch (error) {
      if (error instanceof ZipError) {
        report.files.push({ name: file.name, kind: "opml", status: "error", detail: describeZipError(error) });
        report.errors.push(`${file.name}: ${describeZipError(error)}`);
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      report.files.push({ name: file.name, kind: "opml", status: "error", detail: message });
      report.errors.push(`${file.name}: ${message}`);
    }
  }

  // 3. Articles: starred first, then per-feed files, each chunked + transactional.
  const rank = (name: string) => ((name.split("/").pop() ?? name).startsWith("starred_") ? 0 : 1);
  jsonFiles.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  let totalItems = 0;
  const maxItems = options.maxItems ?? MAX_IMPORT_ITEMS_PER_RUN;
  for (const file of jsonFiles) {
    emit({ phase: "read", file: file.name, done: ++readIndex, total: totalFiles });
    await yieldToEventLoop();
    try {
      // Inflate, parse and import this one file; nothing of it is kept afterwards.
      const { items } = parseFreshRssArticleJson((await file.load()).toString("utf8"));
      if (totalItems + items.length > maxItems) {
        throw new FreshRssJsonError(
          `Import limit reached: more than ${maxItems.toLocaleString("en-US")} articles in one run. This file (${items.length.toLocaleString("en-US")} items) was not imported; split the export and import it in several runs.`,
        );
      }
      // N9: per-user daily article quota (real runs consume it; a dry run only checks it,
      // counting the files of this run it already accepted).
      const quota = peekRateLimit(`user:${userId}`, RATE_LIMITS.importedArticles);
      const pendingInRun = dryRun ? totalItems : 0;
      if (items.length > quota.remaining - pendingInRun) {
        throw new FreshRssJsonError(
          `Daily import limit reached: at most ${RATE_LIMITS.importedArticles.limit.toLocaleString("en-US")} articles per day. This file (${items.length.toLocaleString("en-US")} items) was not imported; try again tomorrow or split the export.`,
        );
      }
      totalItems += items.length;
      const result = await importFreshRssArticles(userId, items, {
        dryRun,
        chunkSize: options.chunkSize,
        plannedFeeds,
        dryRunLedger,
        fileName: file.name,
        onProgress: (p) => emit(p),
      });
      if (!dryRun) consumeRateLimit(`user:${userId}`, RATE_LIMITS.importedArticles, result.counts.created + result.counts.updated);
      report.articles = report.articles ? mergeArticleReports(report.articles, result) : result;
      report.files.push({ name: file.name, kind: "articles", status: "ok", items: items.length });
    } catch (error) {
      if (!(error instanceof FreshRssJsonError) && !(error instanceof ZipError)) throw error;
      const message = error instanceof ZipError ? describeZipError(error) : error.message;
      report.files.push({ name: file.name, kind: "articles", status: "error", detail: message });
      report.errors.push(`${file.name}: ${message}`);
    }
  }

  if (!report.files.some((f) => f.status !== "skipped")) {
    throw new MigrationInputError("The archive contains no OPML or article JSON files");
  }

  report.issues = [...(report.opml?.issues ?? []), ...(report.articles?.issues ?? [])];
  report.progress = [...progress.values()];
  return report;
}

function mergeOpmlReports(a: OpmlImportReport, b: OpmlImportReport): OpmlImportReport {
  return {
    dryRun: a.dryRun,
    feedsAdded: a.feedsAdded + b.feedsAdded,
    feedsUpdated: a.feedsUpdated + b.feedsUpdated,
    categoriesAdded: a.categoriesAdded + b.categoriesAdded,
    categoriesUpdated: a.categoriesUpdated + b.categoriesUpdated,
    rulesCreated: a.rulesCreated + b.rulesCreated,
    rulesUpdated: a.rulesUpdated + b.rulesUpdated,
    errors: [...a.errors, ...b.errors],
    issues: [...a.issues, ...b.issues],
  };
}
