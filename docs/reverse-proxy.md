# Running FeedFerret Behind a Reverse Proxy

FeedFerret runs on port 3000 by default and expects a reverse proxy to terminate HTTPS and forward the correct headers. This guide shows configurations for **Nginx**, **Caddy**, and **Traefik**.

---

## Prerequisite: `AUTH_TRUST_HOST=true`

Since FeedFerret is run behind a proxy, Next-Auth must be told to trust the proxy's `X-Forwarded-Host` header. Without this variable, the CSRF check fails and logins are not possible.

```env
AUTH_TRUST_HOST=true
```

This variable is already included in `.env.example` and is set to `true` by default in `docker-compose.yaml`.

---

## Trusted proxy count

> **Warning — set this to match your setup.** Per-IP rate limits and the sign-in throttle key on the client address. If FeedFerret is reachable **without** a proxy in front, a client can send its own `X-Forwarded-For` and pick any limiter key, which defeats the per-IP limits. Choose the value that matches how traffic reaches the container:
>
> | Setup | Value |
> |---|---|
> | Directly exposed, no proxy | `TRUSTED_PROXY_COUNT=0` (the TCP peer is the client, forwarded headers are ignored) |
> | One proxy: Coolify/Traefik, Nginx, Caddy | `TRUSTED_PROXY_COUNT=1` (right-most `X-Forwarded-For` entry) |
> | Cloudflare → Traefik → FeedFerret | `TRUSTED_PROXY_COUNT=2` |
>
> Unset, empty or invalid means 1, plus a startup warning and a one-time warning on the first request that carries `X-Forwarded-For`. The bundled compose files leave it empty on purpose so that warning stays live until you set it.

Restrict origin access to Cloudflare and app access to Traefik; only trust headers appended by this controlled chain.

**Peer check (Docker image).** The image starts the server with `scripts/peer-address-preload.cjs`, which records the real TCP peer of every request. With `TRUSTED_PROXY_COUNT` ≥ 1, `X-Forwarded-For` is only believed when that peer is loopback, private (10/8, 172.16/12, 192.168/16), link-local, CGNAT (100.64/10) or ULA (fc00::/7) — i.e. your proxy on the Docker network — or is listed in `TRUSTED_PROXIES` (comma separated IPs/CIDRs). A request arriving **directly from a public address** is keyed by that address and its `X-Forwarded-For` is ignored (logged once). If your proxy has a public address (separate host), list it in `TRUSTED_PROXIES`, otherwise all clients share the proxy's key. Without the preload (`next dev`, `next start`) the header-only behaviour applies.

**IPv6.** IPv6 clients are limited per `/64` prefix (a single host owns millions of addresses in its `/64`); IPv4-mapped IPv6 addresses count as their IPv4 address.

**Coolify (Traefik):** exactly one proxy hop, so `TRUSTED_PROXY_COUNT=1`.

## Nginx

### With Let's Encrypt (Certbot)

```nginx
# /etc/nginx/sites-available/feedferret

server {
    listen 80;
    server_name rss.example.com;

    # Let's Encrypt HTTP challenge
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    # Redirect all other requests to HTTPS
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    http2 on;
    server_name rss.example.com;

    ssl_certificate     /etc/letsencrypt/live/rss.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/rss.example.com/privkey.pem;

    # Modern TLS settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    # HSTS (FeedFerret does not set this header itself)
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        proxy_pass http://localhost:3000;

        # Required headers for Next-Auth and correct URL detection
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support (for future realtime features)
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Timeouts for long-running sync requests
        proxy_read_timeout 120s;
        proxy_connect_timeout 10s;
    }
}
```

**Create the certificate:**

```bash
certbot --nginx -d rss.example.com
```

---

### Docker Network (FeedFerret in the Same Compose Stack)

If Nginx also runs as a Docker container and is on the same network, point `proxy_pass` at the service name instead of `localhost`:

```nginx
proxy_pass http://feedferret:3000;
```

---

## Caddy

Caddy obtains and renews Let's Encrypt certificates fully automatically.

### Caddyfile

```caddy
rss.example.com {
    reverse_proxy localhost:3000 {
        header_up Host              {host}
        header_up X-Real-IP         {remote_host}
        header_up X-Forwarded-For   {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    # HSTS (FeedFerret does not set this header itself)
    header Strict-Transport-Security "max-age=31536000; includeSubDomains"

    # WebSocket upgrades are forwarded automatically by Caddy — no extra config needed
}
```

### Docker Network

```caddy
rss.example.com {
    reverse_proxy feedferret:3000 {
        header_up Host              {host}
        header_up X-Real-IP         {remote_host}
        header_up X-Forwarded-For   {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    header Strict-Transport-Security "max-age=31536000; includeSubDomains"
}
```

### Adding Caddy as a Docker Service to the FeedFerret Stack

```yaml
# Addition to docker-compose.yaml

services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - feedferret_net

volumes:
  caddy_data:
  caddy_config:
```

---

## Traefik

### Docker Labels (Recommended Method for Docker Setups)

Add Traefik labels directly to the `feedferret` service in `docker-compose.yaml`:

```yaml
services:
  feedferret:
    # ... existing configuration ...
    labels:
      - "traefik.enable=true"

      # Router: HTTPS
      - "traefik.http.routers.feedferret.rule=Host(`rss.example.com`)"
      - "traefik.http.routers.feedferret.entrypoints=websecure"
      - "traefik.http.routers.feedferret.tls=true"
      - "traefik.http.routers.feedferret.tls.certresolver=letsencrypt"

      # Router: HTTP → HTTPS redirect
      - "traefik.http.routers.feedferret-http.rule=Host(`rss.example.com`)"
      - "traefik.http.routers.feedferret-http.entrypoints=web"
      - "traefik.http.routers.feedferret-http.middlewares=redirect-to-https"

      # Middleware: HTTP redirect
      - "traefik.http.middlewares.redirect-to-https.redirectscheme.scheme=https"
      - "traefik.http.middlewares.redirect-to-https.redirectscheme.permanent=true"

      # Middleware: HSTS (FeedFerret does not set this header itself)
      - "traefik.http.middlewares.feedferret-hsts.headers.stsSeconds=31536000"
      - "traefik.http.middlewares.feedferret-hsts.headers.stsIncludeSubdomains=true"
      - "traefik.http.routers.feedferret.middlewares=feedferret-hsts"

      # Service: Port
      - "traefik.http.services.feedferret.loadbalancer.server.port=3000"

    networks:
      - feedferret_net
      - traefik_proxy   # external Traefik network
```

> **Network note:** Traefik must have access to the `feedferret_net` network, or FeedFerret must join the external Traefik network. Declare the external network in `docker-compose.yaml` as `external: true`:

```yaml
networks:
  feedferret_net:
    driver: bridge
  traefik_proxy:
    external: true
```

### Traefik Static Configuration (traefik.yaml)

Minimal configuration for Traefik with Let's Encrypt:

```yaml
# traefik.yaml

entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
    http:
      tls:
        certResolver: letsencrypt

certificatesResolvers:
  letsencrypt:
    acme:
      email: admin@example.com
      storage: /data/acme.json
      httpChallenge:
        entryPoint: web

providers:
  docker:
    exposedByDefault: false
    network: traefik_proxy

api:
  dashboard: false
```

---

## Common Notes for All Proxies

### Setting `AUTH_URL` Correctly

`AUTH_URL` in `.env` must exactly match the publicly reachable URL — including `https://`, with no trailing slash:

```env
AUTH_URL="https://rss.example.com"
```

### Hiding the Port in Docker Compose

If a reverse proxy sits in front of FeedFerret, port 3000 no longer needs to be exposed on the host. Remove or comment out the `ports` entry in the `feedferret` service so the port is only reachable internally on the Docker network:

```yaml
services:
  feedferret:
    # ports:         # commented out: only reachable internally
    #   - "3000:3000"
    expose:
      - "3000"       # make the port known on the internal network
```

### HSTS

FeedFerret does not set the `Strict-Transport-Security` header itself. All configuration examples in this guide include the header with a one-year validity (`max-age=31536000`). For a first-time setup, a shorter test value (e.g. `max-age=300`) is recommended to avoid lockouts from misconfiguration.

### WebSocket

FeedFerret does not currently use WebSockets in production, but the configurations in this guide correctly forward `Upgrade` connections — this ensures compatibility once realtime features are added.
