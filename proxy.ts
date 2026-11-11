import authConfig from "./auth.config";
import NextAuth from "next-auth";
import { createNonce, cspHeaders, cspMode } from "./lib/csp";
import { NextResponse } from "next/server";
import { NextRequest } from "next/server";

const { auth } = NextAuth(authConfig);

const SUPPORTED_LOCALES = ['en', 'de'];
const DEFAULT_LOCALE = 'en';

function detectLocale(request: NextRequest): string {
  const cookieLocale = request.cookies.get('locale')?.value;
  if (cookieLocale && SUPPORTED_LOCALES.includes(cookieLocale)) return cookieLocale;
  const acceptLang = request.headers.get('Accept-Language') ?? '';
  for (const segment of acceptLang.split(',')) {
    const tag = segment.split(';')[0].trim().substring(0, 2).toLowerCase();
    if (SUPPORTED_LOCALES.includes(tag)) return tag;
  }
  return DEFAULT_LOCALE;
}

const authenticated = auth((request: NextRequest) => {
  const locale = detectLocale(request);
  const response = NextResponse.next({ request: { headers: new Headers(request.headers) } });
  const current = request.cookies.get('locale')?.value;
  if (current !== locale) {
    response.cookies.set('locale', locale, { maxAge: 365 * 24 * 60 * 60, sameSite: 'lax', path: '/' });
  }
  return response;
});

// L3: wrap Auth.js itself — its authorization redirects bypass the inner callback,
// and they must carry the same policy as pages.
export default async function proxy(request: NextRequest, event: Parameters<typeof authenticated>[1]) {
  const csp = cspHeaders(cspMode(process.env.FEEDFERRET_CSP), createNonce(), process.env.NODE_ENV === "development");
  const headers = new Headers(request.headers);
  // Never trust incoming values: a client-sent CSP / x-nonce header would let it pick the nonce.
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("x-nonce");
  if (csp.requestPolicy) headers.set("content-security-policy", csp.requestPolicy);
  if (csp.nonce) headers.set("x-nonce", csp.nonce);
  const response = await authenticated(new NextRequest(request, { headers }), event)
    ?? NextResponse.next({ request: { headers } });
  // See CspHeaders.response: an enforced CSP set here would clobber the renderer's nonce.
  response.headers.delete("content-security-policy");
  response.headers.delete("content-security-policy-report-only");
  for (const [name, value] of Object.entries(csp.response)) response.headers.set(name, value);
  return response;
}

// Public static files stay outside the auth gate: the service worker precaches
// them (also on the login page, before any session exists) and a redirect to
// /login would be cached as the "offline page". Every exclusion is anchored to
// its exact path (dots escaped, `$` / trailing slash) — `/apifoo`, `/swxjs` or
// `/favicon-ico` must stay behind the gate.
// (The matcher must stay a literal: Next analyzes it statically at build time.)
export const config = {
  matcher: [
    "/((?!api(?:/|$)|_next/static/|_next/image(?:/|$)|favicon\\.ico$|logo\\.svg$|sw\\.js$|offline\\.html$|offline-reader\\.js$|manifest\\.json$|icon-[\\w-]+\\.png$).*)",
  ],
};
