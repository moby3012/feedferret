import { db } from "@/lib/db";
import { sendDigestEmail, getDigestArticles, type DigestArticle } from "@/lib/digest-email";
import { generateDigestSummary, type AiProvider } from "@/lib/ai-summary";
import { decryptIfValue } from "@/lib/crypto";
import { randomBytes } from "crypto";
import { logger } from "./logger";
import { writeSystemLog } from "@/lib/system-log";

function getBaseUrl(): string {
    if (process.env.AUTH_URL) return process.env.AUTH_URL.replace(/\/$/, "");
    if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
    return "http://localhost:3000";
}

function getHourAndDayInTimezone(timezone: string): { hour: number; day: number } {
    const tz = timezone || "UTC";
    try {
        const now = new Date();
        const parts = new Intl.DateTimeFormat("en-US", {
            hour: "numeric",
            hour12: false,
            weekday: "short",
            timeZone: tz,
        }).formatToParts(now);
        const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
        const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
        const hour = parseInt(hourStr, 10) % 24;
        const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        return { hour, day: dayMap[weekdayStr] ?? 0 };
    } catch {
        const now = new Date();
        return { hour: now.getUTCHours(), day: now.getUTCDay() };
    }
}

function shouldSendNow(user: {
    digestFrequency: string;
    digestDayOfWeek: number | null;
    digestHour: number;
    digestTimezone: string;
    digestLastSentAt: Date | null;
}): boolean {
    const { hour: currentHour, day: currentDay } = getHourAndDayInTimezone(user.digestTimezone);

    if (currentHour !== user.digestHour) return false;

    if (user.digestFrequency === "weekly") {
        const targetDay = user.digestDayOfWeek ?? 1;
        if (currentDay !== targetDay) return false;
    } else if (user.digestFrequency === "weekdays") {
        // Mon (1) … Fri (5)
        if (currentDay === 0 || currentDay === 6) return false;
    }

    if (!user.digestLastSentAt) return true;

    const hoursSinceLastSent =
        (new Date().getTime() - user.digestLastSentAt.getTime()) / (1000 * 60 * 60);

    if (user.digestFrequency === "daily" || user.digestFrequency === "weekdays") return hoursSinceLastSent >= 23;
    if (user.digestFrequency === "weekly") return hoursSinceLastSent >= 167;

    return false;
}

async function buildAiSummaries(
    user: {
        id: string;
        aiProvider: string | null;
        aiApiKey: string | null;
        aiModel: string | null;
        aiOllamaBaseUrl: string | null;
        aiSummaryLanguage: string;
        digestAiSummary: string;
    },
    articles: DigestArticle[],
): Promise<{ overall: string | null; perFeed: Record<string, string> }> {
    const mode = user.digestAiSummary;
    if (mode === "none" || articles.length === 0) return { overall: null, perFeed: {} };

    const provider = user.aiProvider as AiProvider | null;
    if (!provider) return { overall: null, perFeed: {} };
    const decryptedKey = decryptIfValue(user.aiApiKey);
    if (provider !== "ollama" && !decryptedKey) return { overall: null, perFeed: {} };

    const aiConfig = {
        provider,
        apiKey: decryptedKey,
        model: user.aiModel,
        ollamaBaseUrl: user.aiOllamaBaseUrl,
        language: user.aiSummaryLanguage,
    };

    try {
        if (mode === "full") {
            const summary = await generateDigestSummary(
                articles.map((a) => ({ title: a.title, excerpt: a.excerpt, feedName: a.feedName })),
                "full",
                aiConfig,
            );
            return { overall: summary || null, perFeed: {} };
        }

        if (mode === "per_feed") {
            const grouped = new Map<string, DigestArticle[]>();
            for (const a of articles) {
                if (!grouped.has(a.feedId)) grouped.set(a.feedId, []);
                grouped.get(a.feedId)!.push(a);
            }
            const perFeed: Record<string, string> = {};
            for (const [feedId, group] of grouped) {
                if (group.length < 2) continue; // skip single-article feeds
                try {
                    const s = await generateDigestSummary(
                        group.map((a) => ({ title: a.title, excerpt: a.excerpt, feedName: a.feedName })),
                        "per_feed",
                        aiConfig,
                    );
                    if (s) perFeed[feedId] = s;
                } catch (err) {
                    logger.error(`[digest] per-feed AI summary failed for feed ${feedId}:`, err);
                }
            }
            return { overall: null, perFeed };
        }
    } catch (err) {
        logger.error("[digest] AI summary failed:", err);
        await writeSystemLog("warn", "digest", `AI summary failed: ${String(err)}`, { userId: user.id });
    }

    return { overall: null, perFeed: {} };
}

function resolveSinceDate(
    lookbackHours: number | null,
    lastSentAt: Date | null,
    frequency: string,
): Date {
    if (lookbackHours && lookbackHours > 0) {
        return new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
    }
    if (lastSentAt) return lastSentAt;
    const fallbackHours = frequency === "weekly" ? 7 * 24 : 24;
    return new Date(Date.now() - fallbackHours * 60 * 60 * 1000);
}

export async function runDigestScheduler(): Promise<void> {
    const settings = await db.globalSettings.findUnique({
        where: { id: "global" },
        select: { mailServiceEnabled: true, smtpHost: true },
    });

    if (!settings?.mailServiceEnabled || !settings.smtpHost) return;

    const users = await db.user.findMany({
        where: { digestEnabled: true, email: { not: null } },
        select: {
            id: true,
            name: true,
            email: true,
            uiLanguage: true,
            digestFrequency: true,
            digestDayOfWeek: true,
            digestHour: true,
            digestTimezone: true,
            digestScope: true,
            digestFeedIds: true,
            digestMaxArticles: true,
            digestMinArticles: true,
            digestLookbackHours: true,
            digestGroupByFeed: true,
            digestAiSummary: true,
            digestLastSentAt: true,
            digestUnsubscribeToken: true,
            aiProvider: true,
            aiApiKey: true,
            aiModel: true,
            aiOllamaBaseUrl: true,
            aiSummaryLanguage: true,
        },
    });

    for (const user of users) {
        if (!user.email) continue;
        if (!shouldSendNow(user)) continue;

        try {
            let token = user.digestUnsubscribeToken;
            if (!token) {
                token = randomBytes(32).toString("hex");
                await db.user.update({
                    where: { id: user.id },
                    data: { digestUnsubscribeToken: token },
                });
            }

            const feedIds: string[] | null = user.digestFeedIds
                ? JSON.parse(user.digestFeedIds)
                : null;

            const since = resolveSinceDate(user.digestLookbackHours, user.digestLastSentAt, user.digestFrequency);

            const articles = await getDigestArticles(
                user.id,
                user.digestScope,
                feedIds,
                since,
                user.digestMaxArticles,
            );

            if (articles.length < Math.max(1, user.digestMinArticles)) {
                // Still update lastSentAt to avoid re-evaluating endlessly within the same hour
                await db.user.update({
                    where: { id: user.id },
                    data: { digestLastSentAt: new Date() },
                });
                continue;
            }

            const { overall, perFeed } = await buildAiSummaries(user, articles);

            await sendDigestEmail({
                to: user.email,
                userName: user.name,
                articles,
                unsubscribeToken: token,
                baseUrl: getBaseUrl(),
                locale: user.uiLanguage ?? "en",
                groupByFeed: user.digestGroupByFeed,
                overallSummary: overall,
                feedSummaries: perFeed,
            });

            await db.user.update({
                where: { id: user.id },
                data: { digestLastSentAt: new Date() },
            });

            logger.log(
                `[digest] sent to ${user.email}: ${articles.length} articles`,
            );
            await writeSystemLog("info", "digest", "Digest sent", { to: user.email, articleCount: articles.length });
        } catch (err) {
            logger.error(`[digest] failed for ${user.email}:`, err);
            await writeSystemLog("error", "digest", String(err), { to: user.email });
        }
    }
}
