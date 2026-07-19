# Self-Hosting FeedFerret

This guide describes the complete installation and operation of FeedFerret on your own server.

---

## Requirements

| Requirement | Details |
|---|---|
| **Docker** | Version 24+ with Docker Compose plugin (v2) |
| **RAM** | At least 512 MB, 1 GB recommended |
| **Port** | 3000 (or any free port, configurable) |
| **Alternative** | [Coolify](https://coolify.io/) — supports Git-based deployment directly from the repository |

> **Note on Coolify:** FeedFerret can be deployed as a Docker Compose service in Coolify. Environment variables are set in the Coolify dashboard instead of in an `.env` file.

---

## Deploying with Coolify

[Coolify](https://coolify.io/) is a self-hosted PaaS platform that offers Git-based deployment with automatic SSL certificates and a web UI for environment variables.

### Step by Step

**1. Create a new project in Coolify**

1. Open Coolify → *Projects* → *Add New Project*
2. *Add New Resource* → **Docker Compose**
3. Select **GitHub** (or your Git instance) as the source and connect the `feedferret` repository

**2. Configure the deployment type**

- Deployment Type: **Docker Compose**
- Docker Compose File: `docker-compose.yaml` (in the repo root)
- Branch: `main`

> **Important:** Do not define your own `networks:` block in `docker-compose.yaml`. Coolify automatically adds its own Traefik network entry. A hardcoded custom bridge network isolates the containers from Traefik and causes *Gateway Timeout* errors. The bundled `docker-compose.yaml` is already configured correctly.

**3. Set environment variables in the Coolify dashboard**

Instead of an `.env` file, the variables are entered under *Environment Variables*. Required fields:

| Variable | Description | Example |
|---|---|---|
| `AUTH_SECRET` | Session key (32+ characters) | `openssl rand -base64 32` |
| `AUTH_URL` | Public URL of the instance | `https://rss.example.com` |
| `AUTH_TRUST_HOST` | Must be `true` behind Coolify's Traefik | `true` |
| `POSTGRES_PASSWORD` | DB password (PostgreSQL mode) | random string |

Optional variables (OAuth, email, VAPID) can also be set here — all fields from the *Environment Variables* section further below work identically.

> **Browser render sidecar:** The bundled `docker-compose.yaml` automatically starts a third service (`render-sidecar`, see [`docs/render-sidecar.md`](render-sidecar.md)) alongside `feedferret` and `postgres` — an isolated headless Chromium service for JavaScript-heavy/purely client-side pages that the normal fetcher can't read (used as a fallback for full text and "page → feed"). It is active by default; set `RENDER_SIDECAR_TOKEN` to your own value (the default is `change-me`). To disable it, remove the `render-sidecar` service and the `FEEDFERRET_RENDER_SIDECAR_URL` line from `docker-compose.yaml` — the rest of the app works unchanged without it.

**4. Configure the domain**

Enter the desired domain in Coolify under *Domains*. Coolify automatically issues a Let's Encrypt certificate.

**5. Deploy**

Click *Deploy* — Coolify builds the image, starts the containers, and sets up HTTPS. The first build takes 3–5 minutes.

### Troubleshooting Coolify

| Problem | Cause | Solution |
|---|---|---|
| *Gateway Timeout* after deploy | Custom `networks:` block in the compose file | Remove the `networks:` section from `docker-compose.yaml` — Coolify manages networks itself |
| Login fails / CSRF error | `AUTH_TRUST_HOST` missing | Set `AUTH_TRUST_HOST=true` in Coolify's environment variables |
| `AUTH_URL` is ignored | Coolify doesn't set an `AUTH_URL` | Set it manually in the environment variables with the full `https://` prefix |
| Build fails with `prisma generate` | Cache issue | Enable *Force Rebuild* in Coolify and deploy again |
| PostgreSQL password error after rebuild | Volume still has the old password | Delete the PostgreSQL volume in Coolify's *Volumes* and redeploy (all data will be lost — back up first!) |

---

## Quick Start (5 Minutes)

```bash
# 1. Clone the repository
git clone https://github.com/moby3012/feedferret.git && cd feedferret

# 2. Create the env file
cp .env.example .env

# 3. Set the three required fields (see below)
nano .env

# 4. Start the stack
docker compose up -d --build
```

Then go through the setup wizard at `http://localhost:3000` (or your configured domain).

---

## Environment Variables

### Required Fields

These three variables **must** be set before the first start:

| Variable | Description | Example |
|---|---|---|
| `AUTH_SECRET` | Secret key for sessions and encrypted DB fields | `openssl rand -base64 32` |
| `AUTH_URL` | Public URL of the instance (with protocol, no trailing slash) | `https://rss.example.com` |
| `POSTGRES_PASSWORD` | Password for the PostgreSQL database | `secure-password-here` |

**Generate `AUTH_SECRET`:**

```bash
openssl rand -base64 32
```

> **Important:** `AUTH_SECRET` must remain stable across all deploys. FeedFerret uses this key to encrypt stored API credentials (e.g. AI summary credentials). If you change it, encrypted data in the database becomes unreadable.

**Minimal `.env` to get started:**

```env
AUTH_SECRET="your-generated-key"
AUTH_URL="https://rss.example.com"
AUTH_TRUST_HOST=true
POSTGRES_PASSWORD="secure-password-here"
```

---

### Optional Variables

#### OAuth Login

For login via external identity providers. More details in [`docs/self-hosting-auth-email.md`](./self-hosting-auth-email.md).

```env
# Google OAuth
GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="your-google-secret"

# GitHub OAuth
GITHUB_CLIENT_ID="your-github-client-id"
GITHUB_CLIENT_SECRET="your-github-secret"
```

#### OIDC (e.g. Authelia, Keycloak)

```env
AUTHELIA_CLIENT_ID="feedferret"
AUTHELIA_CLIENT_SECRET="your-oidc-secret"
AUTHELIA_ISSUER="https://auth.example.com"
AUTHELIA_PROVIDER_NAME="Authelia"
```

#### Email Sending

Credentials can be configured here via ENV or in the admin UI (under *Server Management → Email*). Values from the database take precedence.

```env
# Resend
RESEND_API_KEY="re_xxxxxxxxxxxx"
RESEND_FROM_EMAIL="FeedFerret <noreply@example.com>"

# Postmark
POSTMARK_SERVER_TOKEN="your-postmark-token"
POSTMARK_FROM_EMAIL="noreply@example.com"
POSTMARK_MESSAGE_STREAM="outbound"

# Mailgun
MAILGUN_API_KEY="your-mailgun-key"
MAILGUN_DOMAIN="mg.example.com"
MAILGUN_FROM_EMAIL="FeedFerret <noreply@example.com>"
MAILGUN_BASE_URL="https://api.mailgun.net"

# SendGrid
SENDGRID_API_KEY="SG.xxxxxxxxxxxx"
SENDGRID_FROM_EMAIL="noreply@example.com"

# SMTP (any SMTP provider)
SMTP_HOST="smtp.example.com"
SMTP_PORT="587"
SMTP_USER="noreply@example.com"
SMTP_PASSWORD="smtp-password"
SMTP_FROM="FeedFerret <noreply@example.com>"
```

#### Browser Push Notifications (Web Push / VAPID)

```bash
# Generate a VAPID key pair:
pnpm run webpush:keys
```

```env
WEB_PUSH_VAPID_PUBLIC_KEY="your-public-vapid-key"
WEB_PUSH_VAPID_PRIVATE_KEY="your-private-vapid-key"
WEB_PUSH_CONTACT="mailto:admin@example.com"
```

#### Miscellaneous

```env
# 2FA label in authenticator apps
TOTP_ISSUER="FeedFerret"

# Feed sync protection (optional shared secret for the sync endpoint)
SYNC_SECRET="random-string"

# SSRF protection (only disable on trusted single-tenant instances)
TRUSTED_FEED_FETCHING="false"
ALLOW_INTERNAL_FEED_URLS="false"
```

---

## First Start and Setup Wizard

After `docker compose up -d --build`, open the configured URL. The setup wizard walks you through initial configuration in 5 steps:

1. **Create admin account** — set the email address and password for the first administrator account.
2. **Instance settings** — instance name, public URL, registration mode (open / invite-only / closed).
3. **Configure email** (optional) — enter SMTP or API credentials for password reset emails and notifications. Can be skipped and configured later.
4. **Security settings** — 2FA requirement, session duration, privacy options.
5. **Done & starter packs** — on the last step, preconfigured feed collections (starter packs) can be chosen by topic to populate the instance with content right away.

---

## Applying Updates

```bash
# Pull the latest image and restart the containers
docker compose pull && docker compose up -d --build
```

FeedFerret automatically runs database migrations on startup. No manual migration step is needed.

---

## Backup

### PostgreSQL (Default)

```bash
# Create a database dump
docker exec feedferret-postgres pg_dump \
  -U feedferret \
  -d feedferret \
  > feedferret_backup_$(date +%Y%m%d_%H%M%S).sql

# Restore the dump (into an empty database)
docker exec -i feedferret-postgres psql \
  -U feedferret \
  -d feedferret \
  < feedferret_backup_2024_01_01_120000.sql
```

For automated backups, a cron job or a tool like [pgbackuper](https://github.com/2ndquadrant-it/barman) or Restic with the `pg_dump` command above is recommended.

### SQLite

Back up the entire database volume as a tar archive:

```bash
# Back up the volume contents
docker run --rm \
  -v feedferret_db_data:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/feedferret_sqlite_backup_$(date +%Y%m%d_%H%M%S).tar.gz -C /data .
```

---

## SQLite Mode

FeedFerret supports SQLite as an alternative to PostgreSQL — ideal for individuals or test instances without a separate database service.

**1. Adjust `.env`:**

```env
DATABASE_PROVIDER="sqlite"
DATABASE_URL="file:/app/data/dev.db"
```

The `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD` variables are not needed in SQLite mode.

**2. Adjust `docker-compose.yaml`:**

Uncomment the commented-out volume entry and remove or comment out the `postgres` service as well as the `depends_on` block:

```yaml
volumes:
  feedferret_postgres_data:
  feedferret_db_data:   # <-- uncomment this line
```

Mount the volume in the `feedferret` service:

```yaml
services:
  feedferret:
    # ...
    volumes:
      - feedferret_db_data:/app/data
```

The `postgres` service and the `depends_on` block in the `feedferret` service can then be removed entirely.

> **Note:** Switching from SQLite to PostgreSQL later requires a manual data export (OPML/JSON) and re-import. There is no automatic migration tool.

---

## Troubleshooting

| Problem | Cause | Solution |
|---|---|---|
| Login fails / `CSRF` error behind a reverse proxy | `AUTH_TRUST_HOST` not set | Set `AUTH_TRUST_HOST=true` in `.env` |
| Port 3000 already in use | Another service is using the port | Set `PORT=3001` in `.env` and change `ports:` in `docker-compose.yaml` to `"3001:3001"` |
| `Connection refused` to the database at startup | PostgreSQL not ready yet | Check container logs: `docker compose logs postgres`; the health check should catch this automatically |
| `password authentication failed for user "feedferret"` | `POSTGRES_PASSWORD` in `.env` doesn't match the password set at first startup | Delete the volume (`docker compose down -v`) and restart, **or** manually reset the password in the DB |
| Build fails (`ENOENT`, `prisma generate`) | Incomplete clone or node module conflict | Run `docker compose build --no-cache` |
| Images / assets don't load | `AUTH_URL` misconfigured | `AUTH_URL` must exactly match the publicly reachable URL (including `https://`) |
| Container starts, but the health check fails | The application needs longer to start | Increase `start_period` in the health check, or check logs: `docker compose logs feedferret` |

---

## Docker Image Architecture

The `Dockerfile` uses five stages:

| Stage | Base | Purpose |
|---|---|---|
| `base-runtime` | `node:22-slim` + openssl, curl | Shared runtime base (no build tooling) |
| `base-build` | `base-runtime` + python3, make, g++ | Base for all build stages |
| `deps` | `base-build` | Installs npm dependencies via pnpm |
| `builder` | `base-build` | Compiles Next.js |
| `runner` | `base-runtime` | Production image — contains no build tools |

The runner image deliberately contains no native compilers (`g++`, `make`, `python3`) and no `libvips`. The Prisma CLI is installed explicitly at the version pinned in `package.json` (`npm install -g prisma@<version>`) so the CLI and client are guaranteed to match.

---

## Further Documentation

- **Reverse proxy (Nginx, Caddy, Traefik):** [`docs/reverse-proxy.md`](./reverse-proxy.md)
- **OAuth, OIDC, and email providers in detail:** [`docs/self-hosting-auth-email.md`](./self-hosting-auth-email.md)
- **REST API and Google Reader API:** [`docs/api.md`](./api.md)
- **Database details:** [`docs/database.md`](./database.md)
- **Security:** [`docs/security.md`](./security.md)
