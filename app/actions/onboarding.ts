"use server"

import { db } from "@/lib/db";

export async function hasUsers() {
  const count = await db.user.count();
  return count > 0;
}

export async function getAuthProviders() {
  return {
    google: !!process.env.GOOGLE_CLIENT_ID,
    github: !!process.env.GITHUB_CLIENT_ID,
    authelia:
      !!process.env.AUTHELIA_CLIENT_ID &&
      !!process.env.AUTHELIA_CLIENT_SECRET &&
      !!process.env.AUTHELIA_ISSUER,
    autheliaLabel: process.env.AUTHELIA_PROVIDER_NAME || "Authelia",
  };
}
