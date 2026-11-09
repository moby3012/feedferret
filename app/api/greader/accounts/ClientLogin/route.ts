import { NextResponse } from "next/server";
import { createGReaderToken, authenticateGReaderPassword } from "@/lib/greader";

export async function POST(request: Request) {
  const form = await request.formData();
  const email = String(form.get("Email") || form.get("email") || "");
  const password = String(form.get("Passwd") || form.get("password") || "");
  const user = await authenticateGReaderPassword(request, email, password);
  if (!user) return new NextResponse("Error=BadAuthentication\n", { status: 403 });

  const token = createGReaderToken(user.id);
  return new NextResponse(`SID=${token}\nLSID=${token}\nAuth=${token}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
