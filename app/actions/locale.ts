'use server';
import { cookies } from 'next/headers';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { revalidatePath } from 'next/cache';

const SUPPORTED_LOCALES = ['en', 'de'];

export async function updateUiLanguage(locale: string) {
  if (!SUPPORTED_LOCALES.includes(locale)) return { error: 'Unsupported locale' };
  const session = await auth();
  if (!session?.user?.id) return { error: 'Not authenticated' };

  await db.user.update({
    where: { id: session.user.id },
    data: { uiLanguage: locale },
  });

  const cookieStore = await cookies();
  cookieStore.set('locale', locale, { maxAge: 365 * 24 * 60 * 60, sameSite: 'lax', path: '/' });
  revalidatePath('/');
  return { success: true };
}
