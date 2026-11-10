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
  mergeArticleReports,
  parseFreshRssArticleJson,
  type ArticleImportReport,
} from "./freshrss-json";
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

interface InputFile { name: string; data: Buffer }

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
  options: { dryRun?: boolean; limits?: ZipLimits; chunkSize?: number; onProgress?: (progress: MigrationProgress) => void } = {},
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

  // 1. Read the upload into named files (bounded).
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
    const files = archive.entries.filter((entry) => !entry.isDirectory);
    let index = 0;
    for (const entry of files) {
      emit({ phase: "read", file: entry.name, done: ++index, total: files.length });
      const kind = classify(entry.name);
      if (!kind) {
        report.files.push({ name: entry.name, kind: "skipped", status: "skipped", detail: "not an OPML or JSON file" });
        continue;
      }
      try {
        const data = archive.read(entry);
        if (kind === "opml") {
          if (!looksLikeOpml(data.toString("utf8"))) {
            report.files.push({ name: entry.name, kind: "skipped", status: "skipped", detail: "XML file without an <opml> root" });
            continue;
          }
          opmlFiles.push({ name: entry.name, data });
        } else {
          jsonFiles.push({ name: entry.name, data });
        }
      } catch (error) {
        if (!(error instanceof ZipError)) throw error;
        // Archive-wide limits abort the run; a single damaged entry is reported.
        if (["archive-too-large", "entry-too-large", "ratio-exceeded"].includes(error.code)) throw new MigrationInputError(describeZipError(error));
        report.files.push({ name: entry.name, kind: kind === "opml" ? "opml" : "articles", status: "error", detail: describeZipError(error) });
        report.errors.push(`${entry.name}: ${describeZipError(error)}`);
      }
    }
  } else {
    const text = upload.toString("utf8").replace(/^﻿/, "").trimStart();
    if (text.startsWith("<")) {
      report.source = "opml";
      opmlFiles.push({ name: "feeds.opml", data: upload });
    } else if (text.startsWith("{")) {
      report.source = "json";
      jsonFiles.push({ name: "articles.json", data: upload });
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
  for (const file of opmlFiles) {
    try {
      if (file.data.length > MAX_OPML_BYTES) throw new OpmlParseError(`OPML file too large (max ${MAX_OPML_BYTES / 1024 / 1024} MB)`);
      const plan = planOpmlImport(await parseOpml(file.data.toString("utf8")), { trust: "local" });
      collectPlannedFeeds(plan, plannedFeeds);
      const opml = await applyOpmlImportPlan(userId, plan, {
        dryRun,
        onProgress: (p) => emit({ ...p, file: file.name }),
      });
      report.opml = report.opml ? mergeOpmlReports(report.opml, opml) : opml;
      report.files.push({ name: file.name, kind: "opml", status: "ok", items: opml.feedsAdded + opml.feedsUpdated });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.files.push({ name: file.name, kind: "opml", status: "error", detail: message });
      report.errors.push(`${file.name}: ${message}`);
    }
  }

  // 3. Articles: starred first, then per-feed files, each chunked + transactional.
  const rank = (name: string) => ((name.split("/").pop() ?? name).startsWith("starred_") ? 0 : 1);
  jsonFiles.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  for (const file of jsonFiles) {
    try {
      const { items } = parseFreshRssArticleJson(file.data.toString("utf8"));
      const result = await importFreshRssArticles(userId, items, {
        dryRun,
        chunkSize: options.chunkSize,
        plannedFeeds,
        dryRunLedger,
        fileName: file.name,
        onProgress: (p) => emit(p),
      });
      report.articles = report.articles ? mergeArticleReports(report.articles, result) : result;
      report.files.push({ name: file.name, kind: "articles", status: "ok", items: items.length });
    } catch (error) {
      if (!(error instanceof FreshRssJsonError)) throw error;
      report.files.push({ name: file.name, kind: "articles", status: "error", detail: error.message });
      report.errors.push(`${file.name}: ${error.message}`);
    }
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
