export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;

    validateEnvironment();

    // Provisions pg_trgm / FTS5 search acceleration (audit finding P-11).
    // Idempotent and self-contained: it never throws, so a broken index
    // setup degrades to unaccelerated search instead of blocking startup.
    const { ensureSearchIndexes } = await import("./lib/search-indexes");
    await ensureSearchIndexes();

    const { startBackgroundSync } = await import("./lib/background-sync");
    startBackgroundSync();
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
