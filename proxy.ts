import authConfig from "./auth.config";
import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

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

export default auth((request: NextRequest) => {
  const locale = detectLocale(request);
  const response = NextResponse.next();
  const current = request.cookies.get('locale')?.value;
  if (current !== locale) {
    response.cookies.set('locale', locale, { maxAge: 365 * 24 * 60 * 60, sameSite: 'lax', path: '/' });
  }
  return response;
});

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|logo.svg).*)"],
};
