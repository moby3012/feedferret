// The signed-in user as the offline layer sees it. Set by <OfflineSync> (the
// server page passes the session's user id), read by the query fallbacks that
// live outside React. `null` = unknown → the offline layer stays inert.
let offlineUser: string | null = null;

export function setOfflineUser(userId: string | null) {
  offlineUser = userId;
}

export function getOfflineUser(): string | null {
  return offlineUser;
}
