"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import { sendDigestEmail, getDigestArticles } from "@/lib/digest-email";

export async function updateProfile(data: { name?: string; email?: string }) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    await db.user.update({
        where: { id: session.user.id },
        data,
    });

    revalidatePath("/");
}

export async function getReadingPreferences() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");
    const user = await db.user.findUnique({
        where: { id: session.user.id },
        select: {
            openOriginalByDefault: true,
            markReadAfterDelaySecs: true,
            defaultViewMode: true,
            readerWidth: true,
            defaultArticleSort: true,
            accentColor: true,
            secondaryColor: true,
        },
    });
    return {
        openOriginalByDefault: user?.openOriginalByDefault ?? false,
        markReadAfterDelaySecs: user?.markReadAfterDelaySecs ?? null,
        defaultViewMode: user?.defaultViewMode ?? "list",
        readerWidth: user?.readerWidth ?? "normal",
        defaultArticleSort: user?.defaultArticleSort ?? "newest",
        accentColor: user?.accentColor ?? "#5BA4CF",
        secondaryColor: user?.secondaryColor ?? "#F0963C",
    };
}

export async function updateGlobalSettings(data: {
    defaultUpdateFrequency?: number;
    defaultRetentionDays?: number;
    openOriginalByDefault?: boolean;
    markReadAfterDelaySecs?: number | null;
    defaultViewMode?: string;
    readerWidth?: string;
    defaultArticleSort?: string;
    accentColor?: string;
    secondaryColor?: string;
}) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    await db.user.update({
        where: { id: session.user.id },
        data
    });

    revalidatePath("/");
}

export async function getDigestSettings() {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
        where: { id: session.user.id },
        select: {
            digestEnabled: true,
            digestFrequency: true,
            digestDayOfWeek: true,
            digestHour: true,
            digestScope: true,
            digestFeedIds: true,
            digestLastSentAt: true,
        },
    });

    return {
        digestEnabled: user?.digestEnabled ?? false,
        digestFrequency: user?.digestFrequency ?? "daily",
        digestDayOfWeek: user?.digestDayOfWeek ?? 1,
        digestHour: user?.digestHour ?? 8,
        digestScope: user?.digestScope ?? "unread",
        digestFeedIds: user?.digestFeedIds ? (JSON.parse(user.digestFeedIds) as string[]) : [],
        digestLastSentAt: user?.digestLastSentAt ?? null,
    };
}

export async function updateDigestSettings(data: {
    digestEnabled?: boolean;
    digestFrequency?: string;
    digestDayOfWeek?: number;
    digestHour?: number;
    digestScope?: string;
    digestFeedIds?: string[];
}) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    const updateData: Record<string, unknown> = { ...data };

    // Serialize feedIds array → JSON string
    if (data.digestFeedIds !== undefined) {
        updateData.digestFeedIds =
            data.digestFeedIds.length > 0 ? JSON.stringify(data.digestFeedIds) : null;
        delete updateData.digestFeedIds;
        updateData.digestFeedIds =
            data.digestFeedIds.length > 0 ? JSON.stringify(data.digestFeedIds) : null;
    }

    // Ensure unsubscribe token exists when enabling
    if (data.digestEnabled) {
        const user = await db.user.findUnique({
            where: { id: session.user.id },
            select: { digestUnsubscribeToken: true },
        });
        if (!user?.digestUnsubscribeToken) {
            updateData.digestUnsubscribeToken = randomBytes(32).toString("hex");
        }
    }

    await db.user.update({
        where: { id: session.user.id },
        data: updateData,
    });

    revalidatePath("/settings");
}

export async function sendTestDigest() {
    const session = await auth();
    if (!session?.user?.id || !session.user.email) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
        where: { id: session.user.id },
        select: {
            name: true,
            email: true,
            digestScope: true,
            digestFeedIds: true,
            digestUnsubscribeToken: true,
        },
    });

    if (!user?.email) throw new Error("No email address on account");

    let token = user.digestUnsubscribeToken;
    if (!token) {
        token = randomBytes(32).toString("hex");
        await db.user.update({
            where: { id: session.user.id },
            data: { digestUnsubscribeToken: token },
        });
    }

    const feedIds: string[] | null = user.digestFeedIds
        ? JSON.parse(user.digestFeedIds)
        : null;

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const articles = await getDigestArticles(
        session.user.id,
        user.digestScope,
        feedIds,
        since,
    );

    const baseUrl = process.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

    await sendDigestEmail({
        to: user.email,
        userName: user.name,
        articles,
        unsubscribeToken: token,
        baseUrl,
    });

    return { sent: true, articleCount: articles.length };
}
