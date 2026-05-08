#!/usr/bin/env node
import fs from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import Parser from 'rss-parser';

if (!process.env.DATABASE_URL) process.env.DATABASE_URL = 'file:./prisma/dev.db';
const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();
const parser = new Parser();

const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();
const [cmd, ...args] = argv;
function arg(name, fallback = undefined) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : fallback;
}
function usage() {
  console.log(`FeedFerret CLI\n\nCommands:\n  list-users\n  create-user --email EMAIL --password PASS [--name NAME] [--admin true]\n  sync [--user EMAIL]\n  import-opml --user EMAIL --file subscriptions.opml\n  export-opml --user EMAIL --file subscriptions.opml\n  purge [--user EMAIL]\n`);
}

async function findUser() {
  const email = arg('user');
  if (!email) return null;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error(`User not found: ${email}`);
  return user;
}

async function syncUser(user) {
  const feeds = await prisma.feed.findMany({ where: user ? { userId: user.id } : {} });
  let created = 0;
  for (const feed of feeds) {
    try {
      const remote = await parser.parseURL(feed.url);
      for (const item of remote.items) {
        if (!item.link) continue;
        await prisma.article.upsert({
          where: { userId_link: { userId: feed.userId, link: item.link } },
          update: { title: item.title || 'Untitled', excerpt: item.summary || item.contentSnippet || null },
          create: {
            userId: feed.userId,
            feedId: feed.id,
            title: item.title || 'Untitled',
            link: item.link,
            content: item.content || item.summary || '',
            excerpt: item.summary || item.contentSnippet || null,
            author: item.creator || item.author || null,
            publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
          },
        });
        created++;
      }
      await prisma.feed.update({ where: { id: feed.id }, data: { lastFetchedAt: new Date(), lastStatus: 'ok', lastError: null } });
    } catch (error) {
      await prisma.feed.update({ where: { id: feed.id }, data: { lastFetchedAt: new Date(), lastStatus: 'error', lastError: String(error).slice(0, 1000) } });
    }
  }
  console.log(`Synced ${feeds.length} feeds, processed ${created} items.`);
}

async function purge(user) {
  const users = user ? [user] : await prisma.user.findMany();
  let deleted = 0;
  for (const u of users) {
    const feeds = await prisma.feed.findMany({ where: { userId: u.id } });
    for (const feed of feeds) {
      const days = feed.retentionDays ?? u.defaultRetentionDays;
      if (!days || days <= 0) continue;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const result = await prisma.article.deleteMany({ where: { userId: u.id, feedId: feed.id, isRead: true, isStarred: false, publishedAt: { lt: cutoff } } });
      deleted += result.count;
    }
  }
  console.log(`Purged ${deleted} articles.`);
}

try {
  if (!cmd || cmd === 'help') usage();
  else if (cmd === 'list-users') {
    const users = await prisma.user.findMany({ include: { _count: { select: { feeds: true, articles: true } } }, orderBy: { createdAt: 'asc' } });
    console.table(users.map(u => ({ email: u.email, role: u.role, feeds: u._count.feeds, articles: u._count.articles })));
  } else if (cmd === 'create-user') {
    const email = arg('email');
    const password = arg('password');
    if (!email || !password) throw new Error('Missing --email or --password');
    const hash = await bcrypt.hash(password, 12);
    await prisma.user.upsert({ where: { email }, update: { password: hash }, create: { email, name: arg('name'), password: hash, role: arg('admin') === 'true' ? 'ADMIN' : 'USER' } });
    console.log(`User ready: ${email}`);
  } else if (cmd === 'sync') await syncUser(await findUser());
  else if (cmd === 'purge') await purge(await findUser());
  else if (cmd === 'export-opml') {
    const user = await findUser();
    const file = arg('file', 'subscriptions.opml');
    const feeds = await prisma.feed.findMany({ where: { userId: user.id }, include: { category: true }, orderBy: { name: 'asc' } });
    const outlines = feeds.map(f => `    <outline text="${f.name}" title="${f.name}" type="rss" xmlUrl="${f.url}" />`).join('\n');
    await fs.writeFile(file, `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>FeedFerret Export</title></head><body>\n${outlines}\n</body></opml>\n`);
    console.log(`Exported ${feeds.length} feeds to ${file}`);
  } else if (cmd === 'import-opml') {
    console.log('OPML import via CLI is available in the web UI report flow; use Feed Management for detailed reports.');
    process.exitCode = 2;
  } else throw new Error(`Unknown command: ${cmd}`);
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
