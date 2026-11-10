import { cache } from "react";
import { auth } from "@/auth";

/**
 * The request's session, resolved once per request (React `cache`): the root
 * layout seeds `<SessionProvider>` with it and the reader page gates on it —
 * one JWT decode + user lookup instead of one per caller.
 */
export const currentSession = cache(() => auth());
