#!/usr/bin/env node
// Seeds a FRESH, disposable SQLite database for the E2E + perf harness.
//
//   node scripts/e2e-seed.mjs            # -> .e2e/e2e.db + .e2e/manifest.json
//   E2E_DB_PATH=/abs/path.db node scripts/e2e-seed.mjs
//
// Guard rails: the target is ALWAYS a SQLite file (never DATABASE_URL), it must
// live inside the repo's .e2e/ directory unless E2E_ALLOW_CUSTOM_DB=1, and any
// existing file at that path is deleted first. It cannot touch a production DB.
//
// Data: 3 admin users (desktop / mobile / perf, identical but independent
// datasets so projects never interfere), 3 categories, 8 feeds pointing at the
// local fixture feed server, 300 articles (long content, images, code blocks),
// 2 labels, starred + read-later + read states. Articles are inserted directly
// (the SSRF guard blocks fetching localhost fixtures).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import {
  CATEGORIES, FEEDS, FIXTURE_PORT, LABELS, PASSWORD, SEARCH_NEEDLE, USERS, buildArticles,
} from "../e2e/fixtures/data.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const e2eDir = path.join(root, ".e2e");
const dbPath = path.resolve(process.env.E2E_DB_PATH || path.join(e2eDir, "e2e.db"));

if (!dbPath.startsWith(e2eDir + path.sep)) {
  // Hard guard: this script wipes the target DB and creates ADMIN users with a
  // known password, so it must never touch anything outside .e2e/.
  console.error(`[e2e-seed] refusing to write ${dbPath}: outside ${e2eDir}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
for (const suffix of ["", "-journal", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });

// 1. Schema: same path as production start (`prisma db push`), SQLite only.
const env = { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: `file:${dbPath}` };
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    process.exit(r.status ?? 1);
  }
};
run("node", ["scripts/prepare-prisma-schema.mjs"]);
run("npx", ["prisma", "db", "push", "--schema", "prisma/schema.generated.prisma", "--accept-data-loss"]);

// 2. Data.
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbPath }) });
const now = Date.now();
const articles = buildArticles(now);
const passwordHash = await bcrypt.hash(PASSWORD, 10);
const manifest = { generatedAt: new Date(now).toISOString(), password: PASSWORD, users: {} };

for (const u of USERS) {
  const user = await prisma.user.create({
    data: {
      email: u.email, name: u.name, password: passwordHash, role: "ADMIN",
      emailVerified: new Date(now), uiLanguage: "en", displayTimezone: "UTC",
    },
  });
  const cats = {};
  for (const [order, c] of CATEGORIES.entries()) {
    cats[c.key] = (await prisma.category.create({ data: { name: c.name, userId: user.id, order } })).id;
  }
  const feeds = {};
  for (const [order, f] of FEEDS.entries()) {
    feeds[f.slug] = (
      await prisma.feed.create({
        data: {
          name: f.name, url: `http://127.0.0.1:${FIXTURE_PORT}/feeds/${f.slug}.xml`,
          userId: user.id, categoryId: f.category ? cats[f.category] : null, order,
          lastFetchedAt: new Date(now), lastStatus: "ok",
        },
      })
    ).id;
  }
  const labels = {};
  for (const l of LABELS) {
    labels[l.key] = (await prisma.label.create({ data: { name: l.name, color: l.color, userId: user.id } })).id;
  }

  const rows = articles.map((a) => ({
    id: `e2e-${u.key}-${String(a.index).padStart(3, "0")}`,
    feedId: feeds[a.feedSlug], userId: user.id,
    title: a.title, link: a.link, externalId: a.guid, dedupeKey: a.guid,
    content: a.content, excerpt: a.excerpt, author: a.author, imageUrl: a.imageUrl,
    publishedAt: a.publishedAt,
    isRead: a.isRead, readAt: a.isRead ? a.publishedAt : null,
    isStarred: a.isStarred, isReadLater: a.isReadLater,
    readLaterSavedAt: a.isReadLater ? a.publishedAt : null,
  }));
  await prisma.article.createMany({ data: rows });
  await prisma.articleLabel.createMany({
    data: articles.flatMap((a, i) =>
      a.labels.map((key) => ({ articleId: rows[i].id, labelId: labels[key], userId: user.id })),
    ),
  });

  manifest.users[u.key] = {
    email: u.email,
    userId: user.id,
    firstArticleId: rows[0].id,
    firstArticleTitle: articles[0].title,
    // First ~40 chars of the first article's body text (reader content check).
    firstArticleBodyStart: articles[0].excerpt.slice(0, 40),
    firstArticleFeed: FEEDS[0].name,
    // Article numbers (#NNN in titles) with notable traits.
    sample: {
      code: articles.find((a) => a.traits.hasCode && !a.isRead).title,
      image: articles.find((a) => a.traits.hasImage && !a.isRead).title,
      long: articles.find((a) => a.traits.isLong && !a.isRead).title,
      needle: SEARCH_NEEDLE,
      needleHits: articles.filter((a) => a.traits.needle).length,
    },
    counts: {
      total: articles.length,
      unread: articles.filter((a) => !a.isRead).length,
      starred: articles.filter((a) => a.isStarred).length,
      readLater: articles.filter((a) => a.isReadLater).length,
    },
  };
}

// 3. Pristine snapshot of the mutable flags, so specs can reset state between
//    tests with one UPDATE (see e2e/helpers/db.ts). Not part of the app schema.
await prisma.$executeRawUnsafe(
  `CREATE TABLE e2e_pristine (articleId TEXT PRIMARY KEY, isRead INTEGER, readAt DATETIME, isStarred INTEGER, isReadLater INTEGER, readLaterSavedAt DATETIME)`,
);
await prisma.$executeRawUnsafe(
  `INSERT INTO e2e_pristine SELECT id, isRead, readAt, isStarred, isReadLater, readLaterSavedAt FROM "Article"`,
);
await prisma.$disconnect();

fs.writeFileSync(path.join(path.dirname(dbPath), "manifest.json"), JSON.stringify({ ...manifest, dbPath }, null, 2));
console.log(`[e2e-seed] ${dbPath}: ${USERS.length} users x (${CATEGORIES.length} categories, ${FEEDS.length} feeds, ${articles.length} articles)`);
