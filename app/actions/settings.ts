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
        select: { openOriginalByDefault: true },
    });
    return { openOriginalByDefault: user?.openOriginalByDefault ?? false };
}

export async function updateGlobalSettings(data: {
    defaultUpdateFrequency?: number;
    defaultRetentionDays?: number;
    openOriginalByDefault?: boolean;
}) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    await db.user.update({
        where: { id: session.user.id },
        data
    });

    revalidatePath("/");
}
