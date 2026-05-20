import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';

const SUPPORTED_LOCALES = ['en', 'de'];

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const raw = cookieStore.get('locale')?.value;
  const locale = raw && SUPPORTED_LOCALES.includes(raw) ? raw : 'en';
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
