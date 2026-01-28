"use server"

import { db } from "@/lib/db";

export async function hasUsers() {
    const count = await db.user.count();
    return count > 0;
}
