# Self-hosting: 2FA, Authelia OAuth, and Email Providers

This document covers the new authentication and email options for self-hosted FeedFerret.

## 1. Optional TOTP 2FA

FeedFerret supports optional authenticator-app based 2FA for local email/password logins.

### What users do

1. Open **Settings**.
2. Start **Two-factor authentication** setup.
3. Add the shown secret to an authenticator app like:
   - 1Password
   - Authy
   - Aegis
   - Google Authenticator
   - Apple Passwords / iCloud Keychain (if supported on device)
4. Enter the current 6-digit code to confirm.

### Notes

- 2FA currently protects **local credentials login**.
- OAuth logins such as **Google**, **GitHub**, or **Authelia** handle MFA upstream at the identity provider.
- Accounts with 2FA enabled **cannot use Google Reader password auth / ClientLogin**. Those flows do not have a second-factor prompt.
- `TOTP_ISSUER` is optional and controls the label shown in authenticator apps.

```env
# Optional branding for authenticator apps
# TOTP_ISSUER="FeedFerret"
```

---

## 2. Email provider setup

FeedFerret can send email through:

- SMTP
- Resend
- Postmark
- Mailgun
- SendGrid

### How it works

All providers can be configured in two ways — pick whichever is easier for your setup:

**Option A — Admin UI (recommended for most users):**
Go to **Server Management → Email**, select your provider, and enter credentials directly. Credentials are stored encrypted (AES-256-GCM) in the database. No environment variables needed.

**Option B — Environment variables:**
Set the provider-specific ENV vars (see below). These act as a fallback when no DB value is set. DB values always take priority over ENV values.

You can mix both: for example, set SMTP via the Admin UI and keep OAuth providers as ENV vars.

### SMTP

No extra environment variables are required.

Configure these directly in the admin UI:

- SMTP host
- SMTP port
- SMTP username
- SMTP password
- From email

### Resend

```env
RESEND_API_KEY="re_xxxxxxxxx"
RESEND_FROM_EMAIL="FeedFerret <noreply@example.com>"
```

### Postmark

```env
POSTMARK_SERVER_TOKEN="xxxxxxxxx"
POSTMARK_FROM_EMAIL="noreply@example.com"
# Optional
# POSTMARK_MESSAGE_STREAM="outbound"
```

### Mailgun

```env
MAILGUN_API_KEY="key-xxxxxxxxx"
MAILGUN_DOMAIN="mg.example.com"
MAILGUN_FROM_EMAIL="FeedFerret <noreply@example.com>"
# Optional EU endpoint example:
# MAILGUN_BASE_URL="https://api.eu.mailgun.net"
```

### SendGrid

```env
SENDGRID_API_KEY="SG.xxxxx"
SENDGRID_FROM_EMAIL="noreply@example.com"
```

### Mail service toggle

After configuring a provider:

1. Open **Server Management** as admin.
2. Go to the **Email** tab.
3. Enable **Mail Service**.
4. Choose the provider.
5. Enter credentials (or leave blank if set via ENV).
6. Save.
7. Send a test email.

> **Credential security:** API keys entered through the Admin UI are stored encrypted with AES-256-GCM, with the encryption key derived from your `AUTH_SECRET`. Never lose your `AUTH_SECRET` — it is needed to decrypt stored credentials.

### What email is used for

- Auth.js magic links / sign-in emails
- Digest emails
- Future transactional email features

---

## 3. Authelia OAuth / OIDC login

FeedFerret supports Authelia through a generic OIDC provider.

### Required environment variables

```env
AUTHELIA_CLIENT_ID="feedferret"
AUTHELIA_CLIENT_SECRET="change-me"
AUTHELIA_ISSUER="https://auth.example.com"
# Optional label shown on the login page
# AUTHELIA_PROVIDER_NAME="Authelia"
```

### Redirect URI

In Authelia, configure this callback URL:

```text
https://your-feedferret-host/api/auth/callback/authelia
```

For local development:

```text
http://localhost:3000/api/auth/callback/authelia
```

### Recommended scopes / claims

Make sure the userinfo/id token provides at least:

- `sub`
- `email`
- `name` or `preferred_username`

### Notes

- If Authelia already enforces MFA, you usually do **not** need to enable FeedFerret local TOTP for those users.
- Registrations still respect FeedFerret's **Allow New Registrations** server setting.

---

## 4. Example `.env`

```env
DATABASE_URL="file:./prisma/dev.db"
NEXTAUTH_SECRET="replace-me"
NEXTAUTH_URL="https://rss.example.com"

# Optional OAuth
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
GITHUB_CLIENT_ID=""
GITHUB_CLIENT_SECRET=""
AUTHELIA_CLIENT_ID="feedferret"
AUTHELIA_CLIENT_SECRET="change-me"
AUTHELIA_ISSUER="https://auth.example.com"
AUTHELIA_PROVIDER_NAME="Authelia"

# Optional 2FA label
TOTP_ISSUER="FeedFerret"

# Optional API mail providers (configure one or more)
RESEND_API_KEY=""
RESEND_FROM_EMAIL="FeedFerret <noreply@example.com>"

POSTMARK_SERVER_TOKEN=""
POSTMARK_FROM_EMAIL="noreply@example.com"
POSTMARK_MESSAGE_STREAM="outbound"

MAILGUN_API_KEY=""
MAILGUN_DOMAIN="mg.example.com"
MAILGUN_FROM_EMAIL="FeedFerret <noreply@example.com>"
MAILGUN_BASE_URL="https://api.mailgun.net"

SENDGRID_API_KEY=""
SENDGRID_FROM_EMAIL="noreply@example.com"
```
