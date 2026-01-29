"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import nodemailer from "nodemailer";

async function checkAdmin() {
    const session = await auth();
    if (session?.user?.role !== "ADMIN") {
        throw new Error("Unauthorized: Admin access required");
    }
    return session;
}

export async function getUsers() {
    await checkAdmin();
    return await db.user.findMany({
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            name: true,
            email: true,
            role: true,
            image: true,
            createdAt: true,
        },
    });
}

export async function updateUserRole(userId: string, role: string) {
    await checkAdmin();
    await db.user.update({
        where: { id: userId },
        data: { role },
    });
    revalidatePath("/");
}

export async function deleteUser(userId: string) {
    const session = await checkAdmin();
    if (session.user.id === userId) {
        throw new Error("Cannot delete your own account");
    }
    await db.user.delete({
        where: { id: userId },
    });
    revalidatePath("/");
}

export async function getGlobalSettings() {
    await checkAdmin();
    let settings = await db.globalSettings.findUnique({
        where: { id: "global" },
    });

    if (!settings) {
        settings = await db.globalSettings.create({
            data: { id: "global" },
        });
    }

    return settings;
}

export async function updateGlobalSettings(data: any) {
    await checkAdmin();
    await db.globalSettings.upsert({
        where: { id: "global" },
        update: data,
        create: { id: "global", ...data },
    });
    revalidatePath("/");
}

export async function testSmtp(config: any) {
    await checkAdmin();

    const transporter = nodemailer.createTransport({
        host: config.smtpHost,
        port: Number(config.smtpPort),
        secure: Number(config.smtpPort) === 465,
        auth: {
            user: config.smtpUser,
            pass: config.smtpPassword,
        },
    });

    try {
        await transporter.verify();
        return { success: true };
    } catch (error: any) {
        console.error("SMTP Test Failed:", error);
        return { success: false, error: error.message };
    }
}

export async function sendTestEmail(config: any, to: string) {
    await checkAdmin();

    const transporter = nodemailer.createTransport({
        host: config.smtpHost,
        port: Number(config.smtpPort),
        secure: Number(config.smtpPort) === 465,
        auth: {
            user: config.smtpUser,
            pass: config.smtpPassword,
        },
    });

    try {
        await transporter.sendMail({
            from: config.smtpFrom,
            to,
            subject: "FeedFerret SMTP Test",
            text: "If you are reading this, your SMTP configuration is working correctly!",
            html: "<b>If you are reading this, your SMTP configuration is working correctly!</b>",
        });
        return { success: true };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
}
