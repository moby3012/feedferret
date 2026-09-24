'use server';
import { cookies } from 'next/headers';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { isValidTimeZone } from '@/lib/timezone';

const TZ_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/**
 * `timezone: string` sets an explicit display timezone (persisted, always
 * wins). `timezone: null` reverts to auto-detect — the caller must pass the
 * browser's just-detected zone as `effectiveTimezone` so the `timezone`
 * cookie (the single value i18n/request.ts reads) has something concrete to
 * fall back to immediately, without waiting for the next page load to
 * re-seed it.
 */
export async function updateDisplayTimezone(timezone: string | null, effectiveTimezone?: string) {
  if (timezone !== null && !isValidTimeZone(timezone)) return { error: 'Invalid timezone' };
  const session = await auth();
  if (!session?.user?.id) return { error: 'Not authenticated' };

  await db.user.update({
    where: { id: session.user.id },
    data: { displayTimezone: timezone },
  });

  const cookieValue = timezone ?? effectiveTimezone;
  if (cookieValue && isValidTimeZone(cookieValue)) {
    const cookieStore = await cookies();
    cookieStore.set('timezone', cookieValue, { maxAge: TZ_COOKIE_MAX_AGE, sameSite: 'lax', path: '/' });
  }

  revalidatePath('/');
  return { success: true };
}
