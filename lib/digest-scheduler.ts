import { db } from "@/lib/db";
import { sendDigestEmail, getDigestArticles } from "@/lib/digest-email";
import { randomBytes } from "crypto";
import { logger } from "./logger";

function getBaseUrl(): string {
    if (process.env.AUTH_URL) return process.env.AUTH_URL.replace(/\/$/, "");
    if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
    return "http://localhost:3000";
}

function shouldSendNow(user: {
    digestFrequency: string;
    digestDayOfWeek: number | null;
    digestHour: number;
    digestLastSentAt: Date | null;
}): boolean {
    const now = new Date();
    const currentHour = now.getUTCHours();
    const currentDay = now.getUTCDay();

    if (currentHour !== user.digestHour) return false;

    if (user.digestFrequency === "weekly") {
        const targetDay = user.digestDayOfWeek ?? 1;
        if (currentDay !== targetDay) return false;
    }

    if (!user.digestLastSentAt) return true;

    const hoursSinceLastSent =
        (now.getTime() - user.digestLastSentAt.getTime()) / (1000 * 60 * 60);

    if (user.digestFrequency === "daily") return hoursSinceLastSent >= 23;
    if (user.digestFrequency === "weekly") return hoursSinceLastSent >= 167;

    return false;
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
            digestScope: true,
            digestFeedIds: true,
            digestLastSentAt: true,
            digestUnsubscribeToken: true,
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

            // Fetch articles published since last digest (or last 24h / 7d)
            const since = user.digestLastSentAt
                ? user.digestLastSentAt
                : new Date(
                      Date.now() -
                          (user.digestFrequency === "weekly"
                              ? 7 * 24 * 60 * 60 * 1000
                              : 24 * 60 * 60 * 1000),
                  );

            const articles = await getDigestArticles(user.id, user.digestScope, feedIds, since);

            if (articles.length === 0) {
                // Still update lastSentAt to avoid hammering on empty days
                await db.user.update({
                    where: { id: user.id },
                    data: { digestLastSentAt: new Date() },
                });
                continue;
            }

            await sendDigestEmail({
                to: user.email,
                userName: user.name,
                articles,
                unsubscribeToken: token,
                baseUrl: getBaseUrl(),
                locale: user.uiLanguage ?? "en",
            });

            await db.user.update({
                where: { id: user.id },
                data: { digestLastSentAt: new Date() },
            });

            logger.log(
                `[digest] sent to ${user.email}: ${articles.length} articles`,
            );
        } catch (err) {
            logger.error(`[digest] failed for ${user.email}:`, err);
        }
    }
}
