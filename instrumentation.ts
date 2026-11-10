import { validateAuthSecret } from "./lib/auth-secret";

export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;

    if (process.env.NEXT_PHASE !== "phase-production-build") validateAuthSecret();
    validateEnvironment();

    if (process.env.NEXT_PHASE !== "phase-production-build") {
        void (async () => {
            try {
                const { backfillFeverKeys } = await import("./lib/fever-keys");
                await backfillFeverKeys();
            } catch (error) {
                console.error("[fever-keys] startup backfill failed; legacy keys migrate on use", error);
            }
        })();
    }

    // Provisions pg_trgm / FTS5 search acceleration (audit finding P-11).
    // Idempotent and self-contained: it never throws, so a broken index
    // setup degrades to unaccelerated search instead of blocking startup.
    // Deliberately NOT awaited (audit R3): the one-time FTS backfill / trigram index
    // build is O(corpus) (11 s at 50 k articles) and the first HTTP response must not
    // wait for it. Search uses the plain LIKE path until the index is complete.
    // Postgres stays awaited (old behaviour): its plain `CREATE INDEX … USING GIN`
    // takes a SHARE lock that would block article writes if it ran under live traffic.
    if (process.env.NEXT_PHASE !== "phase-production-build") {
        const { getDatabaseProvider } = await import("./lib/db");
        const setup = (async () => {
            const { ensureSearchIndexes } = await import("./lib/search-indexes");
            await ensureSearchIndexes();
            // SQLite planner statistics (audit R1): off the boot path, bounded sample.
            const { scheduleStartupSqliteOptimize } = await import("./lib/db-maintenance");
            scheduleStartupSqliteOptimize();
        })().catch((error) => console.error("[search-indexes] startup setup failed", error));
        if (getDatabaseProvider() === "postgresql") await setup;
    }

    if (process.env.NEXT_PHASE !== "phase-production-build") {
        void (async () => {
            const { db } = await import("./lib/db");
            const { backfillExternalIds } = await import("./lib/external-id-store");
            await backfillExternalIds(db as unknown as import("@prisma/client").PrismaClient);
        })().catch((error) => console.error("[external-ids] startup backfill failed; will retry during background sync", error));
    }

    // Security audit #2 N3: legacy feed URLs (and synthetic article links)
    // carried the RSSHub key / changedetection.io token; strip them
    // (idempotent, background, never delays startup).
    // - Article links: always (no build ever fetched an article link, so a
    //   rollback is unaffected). Bounded to connector feeds' articles.
    // - Feed URLs: opt-in this release so a rollback to an older build, which
    //   expects keyed URLs, keeps working: FEEDFERRET_MIGRATE_CONNECTOR_URLS=1.
    // Fetch-time injection and output redaction work for keyed and keyless rows.
    if (process.env.NEXT_PHASE !== "phase-production-build") {
        void (async () => {
            const { connectorUrlMigrationEnabled, migrateConnectorFeedUrls, scrubConnectorSecretsFromArticleLinks } = await import("./lib/connector-secrets");
            const { db } = await import("./lib/db");
            const articles = await scrubConnectorSecretsFromArticleLinks(db as never);
            if (articles.scrubbed) console.info("[connector-secrets] article link cleanup", articles);
            if (!connectorUrlMigrationEnabled()) return;
            const feeds = await migrateConnectorFeedUrls(db as never);
            if (feeds.migrated || feeds.skipped) console.info("[connector-secrets] feed URL migration", feeds);
        })().catch((error) => console.error("[connector-secrets] startup cleanup failed; secrets stay redacted on output", error));
    }

    const { startBackgroundSync } = await import("./lib/background-sync");
    startBackgroundSync();

    // Fills Article.kind / readMinutes / media* for rows synced before those
    // columns existed. Background + batched; never delays startup.
    if (process.env.NEXT_PHASE !== "phase-production-build") {
        const { startArticleMetaBackfill } = await import("./lib/article-meta-backfill");
        startArticleMetaBackfill();
    }
}

const INSECURE_DEFAULTS = [
    "your-super-secret-key-change-this",
    "your-secret-here",
    "change-me",
    "secret",
    "changeme",
];

function validateEnvironment() {
    const warnings: string[] = [];

    // AUTH_SECRET checks
    const secret = process.env.AUTH_SECRET ?? "";
    if (!secret) {
        warnings.push("AUTH_SECRET is not set. This is required for session security.");
    } else if (secret.length < 32) {
        warnings.push(`AUTH_SECRET is too short (${secret.length} chars). Use at least 32 random characters: openssl rand -base64 32`);
    } else if (INSECURE_DEFAULTS.some((d) => secret.toLowerCase().includes(d.toLowerCase()))) {
        warnings.push("AUTH_SECRET appears to be a placeholder value. Generate a secure secret: openssl rand -base64 32");
    }

    // POSTGRES_PASSWORD checks (only relevant when using PostgreSQL)
    const provider = process.env.DATABASE_PROVIDER ?? "postgresql";
    if (provider === "postgresql" || provider === "postgres") {
        const pgPass = process.env.POSTGRES_PASSWORD ?? "";
        if (pgPass === "feedferret-change-me" || pgPass === "change-me" || pgPass === "") {
            warnings.push("POSTGRES_PASSWORD is using the default placeholder. Set a strong password before exposing this instance.");
        }
    }

    // AUTH_URL check
    const authUrl = process.env.AUTH_URL ?? "";
    if (!authUrl) {
        warnings.push("AUTH_URL is not set. Set it to your public-facing URL (e.g. https://rss.example.com).");
    } else if (authUrl.includes("feedferret.example.com")) {
        warnings.push("AUTH_URL is still set to the placeholder 'feedferret.example.com'. Update it to your actual domain.");
    }

    if (warnings.length > 0) {
        console.warn("\n⚠️  FeedFerret configuration warnings:");
        for (const w of warnings) {
            console.warn(`   • ${w}`);
        }
        console.warn("");
    }
}
