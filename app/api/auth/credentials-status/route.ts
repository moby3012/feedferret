import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";

export async function POST(request: Request) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json({ error: "Missing credentials" }, { status: 400 });
    }

    const user = await db.user.findUnique({
      where: { email: String(email).trim() },
      select: {
        password: true,
        isActive: true,
        twoFactorEnabled: true,
      },
    });

    if (!user?.password || user.isActive === false) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    const passwordMatches = await bcrypt.compare(String(password), user.password);
    if (!passwordMatches) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    return NextResponse.json({
      requiresTwoFactor: !!user.twoFactorEnabled,
    });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
