import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';

const SUPPORTED_LOCALES = ['en', 'de'];

/**
 * Parses an `Accept-Language` header value (e.g. "de-DE,de;q=0.9,en;q=0.8")
 * and returns the first supported locale in the browser's preference order.
 */
export function pickLocaleFromAcceptLanguage(header: string | null): string | null {
  if (!header) return null;
  const preferences = header
    .split(',')
    .map((part) => {
      const [tag, qPart] = part.trim().split(';q=');
      return { tag: tag.trim().toLowerCase(), q: qPart ? parseFloat(qPart) : 1 };
    })
    .sort((a, b) => b.q - a.q);
  for (const { tag } of preferences) {
    const primary = tag.split('-')[0];
    if (SUPPORTED_LOCALES.includes(primary)) return primary;
  }
  return null;
}

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const raw = cookieStore.get('locale')?.value;
  // The cookie only exists once a logged-in user explicitly picks a UI
  // language (app/actions/locale.ts). Anonymous visitors on public pages
  // (login, register, setup) never get one, so without this fallback they
  // always see English on first visit regardless of their browser's language.
  const locale =
    raw && SUPPORTED_LOCALES.includes(raw)
      ? raw
      : pickLocaleFromAcceptLanguage((await headers()).get('accept-language')) ?? 'en';
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
