import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
    try {
        const { name, email, password } = await req.json();

        if (!email || !password) {
            return NextResponse.json(
                { message: "Missing required fields" },
                { status: 400 }
            );
        }

        const settings = await db.globalSettings.findUnique({
            where: { id: "global" },
            select: { registrationsEnabled: true },
        });
        const userCount = await db.user.count();
        // Always allow the very first user (admin bootstrap). After that, respect the setting.
        if (userCount > 0 && !(settings?.registrationsEnabled ?? true)) {
            return NextResponse.json(
                { message: "Registrations are currently disabled on this instance" },
                { status: 403 }
            );
        }

        const existingUser = await db.user.findUnique({
            where: { email },
        });

        if (existingUser) {
            return NextResponse.json(
                { message: "User already exists" },
                { status: 400 }
            );
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const role = userCount === 0 ? "ADMIN" : "USER";

        const user = await db.user.create({
            data: {
                name,
                email,
                password: hashedPassword,
                role,
            },
        });

        return NextResponse.json(
            { message: "User created successfuly", userId: user.id },
            { status: 201 }
        );
    } catch (error) {
        logger.error("Registration error:", error);
        return NextResponse.json(
            { message: "Internal server error" },
            { status: 500 }
        );
    }
}
