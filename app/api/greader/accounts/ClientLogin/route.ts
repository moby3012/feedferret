import { readGReaderBody } from "@/lib/bounded-body";
import { NextResponse } from "next/server";
import { createGReaderToken, authenticateGReaderPassword } from "@/lib/greader";

export async function POST(request: Request) {
  try {
    let raw;
    try { raw = await readGReaderBody(request, 8192); } catch { return new NextResponse("Request too large", { status: 413 }); }
    const form = await new Request(request.url, { method: "POST", headers: request.headers, body: raw }).formData();
    const email = String(form.get("Email") || form.get("email") || "");
    const password = String(form.get("Passwd") || form.get("password") || "");
    const user = await authenticateGReaderPassword(request, email, password);
    if (!user) return new NextResponse("Error=BadAuthentication\n", { status: 403 });

    const token = createGReaderToken(user.id, user.apiTokenVersion);
    return new NextResponse(`SID=${token}\nLSID=${token}\nAuth=${token}\n`, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
