import { NextResponse } from "next/server";

/**
 * DEPRECATED, remove in the next release. This used to answer 401 for unknown addresses and 200 plus a
 * two-factor flag for known ones, which let anyone enumerate accounts and see who uses 2FA. The login
 * form no longer calls it (the sign-in itself asks for the code once the password verified). It stays
 * for one release only so login pages that were open during the upgrade keep working for accounts
 * without 2FA; it looks at nothing and answers every request the same.
 */
export async function POST() {
  return NextResponse.json({ requiresTwoFactor: false }, { headers: { "Cache-Control": "no-store" } });
}
