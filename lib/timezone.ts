// Shared IANA timezone validation, used by both the display-timezone setting
// (i18n/request.ts + app/actions/timezone.ts) and anywhere else that accepts a
// user-supplied timezone string instead of a fixed dropdown value.
export function isValidTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}
