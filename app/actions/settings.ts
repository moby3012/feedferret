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

export async function updateGlobalSettings(data: { defaultUpdateFrequency?: number }) {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Unauthorized");

    await db.user.update({
        where: { id: session.user.id },
        data
    });

    revalidatePath("/");
}
