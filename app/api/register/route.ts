import { hashPassword } from "@/lib/password-hash";
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

        const hashedPassword = await hashPassword(password);
        const result = await db.$transaction(async (tx) => {
            const settings = await tx.globalSettings.findUnique({ where: { id: "global" } });
            const userCount = await tx.user.count();
            if (userCount > 0 && settings && !settings.registrationsEnabled) return null;
            if (!settings && userCount === 0) {
                await tx.globalSettings.create({ data: { id: "global", registrationsEnabled: false } });
            }
            return tx.user.create({
                data: { name, email, password: hashedPassword, role: userCount === 0 ? "ADMIN" : "USER" },
            });
        }, { isolationLevel: "Serializable" });
        if (!result) return NextResponse.json({ message: "Registrations are currently disabled on this instance" }, { status: 403 });
        const user = result;

        return NextResponse.json(
            { message: "User created successfuly", userId: user.id },
            { status: 201 }
        );
    } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
            return NextResponse.json({ message: "Registration failed" }, { status: 400 });
        }
        if (error && typeof error === "object" && "code" in error && ["P2034", "P1008", "P2028"].includes(String(error.code))) {
            return NextResponse.json({ message: "Registration failed; please retry" }, { status: 409 });
        }
        logger.error("Registration error:", error);
        return NextResponse.json(
            { message: "Internal server error" },
            { status: 500 }
        );
    }
}
