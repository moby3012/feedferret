"use client";
import { signOut as authSignOut } from "next-auth/react";

export async function signOut(options?: Parameters<typeof authSignOut>[0]) {
  try {
    if ("caches" in window) await Promise.all((await caches.keys()).map(key => caches.delete(key)));
  } catch { /* Cache storage can be unavailable in private browsing. */ }
  return authSignOut(options);
}
