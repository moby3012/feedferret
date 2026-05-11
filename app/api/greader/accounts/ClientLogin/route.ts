import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { createGReaderToken } from "@/lib/greader";

export async function POST(request: Request) {
  const form = await request.formData();
  const email = String(form.get("Email") || form.get("email") || "");
  const password = String(form.get("Passwd") || form.get("password") || "");
  const user = email ? await db.user.findUnique({ where: { email } }) : null;

  if (!user?.password || !(await bcrypt.compare(password, user.password))) {
    return new NextResponse("Error=BadAuthentication\n", { status: 403 });
  }

  if (user.twoFactorEnabled) {
    return new NextResponse("Error=TwoFactorRequired\n", { status: 403 });
  }

  const token = createGReaderToken(user.id);
  return new NextResponse(`SID=${token}\nLSID=${token}\nAuth=${token}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
