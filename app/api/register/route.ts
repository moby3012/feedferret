import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { checkRateLimit, getClientIdentifier, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { RegisterUserSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
    const identifier = getClientIdentifier(req);
    const rateLimitResult = checkRateLimit(identifier, RATE_LIMITS.authSignIn);
    if (!rateLimitResult.success) return rateLimitResponse(rateLimitResult);

    try {
        const body = await req.json().catch(() => ({}));
        const parsed = RegisterUserSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json(
                { message: parsed.error.issues[0]?.message ?? "Invalid input" },
                { status: 400 }
            );
        }
        const { name, email, password } = parsed.data;

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
                { message: "Registration failed" },
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
