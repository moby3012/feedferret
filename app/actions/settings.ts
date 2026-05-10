"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

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
        },
    });
    return {
        openOriginalByDefault: user?.openOriginalByDefault ?? false,
        markReadAfterDelaySecs: user?.markReadAfterDelaySecs ?? null,
        defaultViewMode: user?.defaultViewMode ?? "list",
        readerWidth: user?.readerWidth ?? "normal",
        defaultArticleSort: user?.defaultArticleSort ?? "newest",
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
}) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    await db.user.update({
        where: { id: session.user.id },
        data
    });

    revalidatePath("/");
}
