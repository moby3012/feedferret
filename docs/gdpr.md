# GDPR / Right to Erasure

FeedFerret implements GDPR Article 17 — the right to erasure ("right to be forgotten").

## User-initiated account deletion

Users can delete their own account from the **Settings** page.

**Path:** Settings → Delete Account (bottom of page)

**What gets deleted:**
- User account and profile
- All RSS feeds and feed subscriptions
- All articles (read state, starred, read later)
- All categories and labels
- All saved searches
- Email digest settings and unsubscribe tokens
- API token
- 2FA secret
- All sessions (user is signed out)

Deletion is handled by a Prisma cascade on the `User` model. All related records are removed atomically.

**Safeguard:** The last admin account cannot be deleted. The user must first assign another admin, then delete their account.

**Confirmation:** The user must type `delete my account` into a confirmation input before the deletion proceeds. This prevents accidental deletion.

## Admin-initiated deletion

Admins can delete any user account from **Server Management → Users → Delete (trash icon)**.

Same cascade rules apply. Admins cannot delete their own account through the admin panel (to prevent accidentally locking out the instance).

## Data export

FeedFerret does not currently provide a GDPR data export (Article 20 portability). Users can manually export their feeds as OPML from the feed management section.

## Notes for self-hosters

- FeedFerret does not send user data to any third-party analytics or tracking services.
- Article content is fetched from RSS feeds and stored locally in your SQLite database.
- Email credentials (SMTP passwords, API keys) are stored encrypted in the database using AES-256-GCM with a key derived from `AUTH_SECRET`.
- Session data is stored as signed JWT tokens — no session state is persisted server-side.
