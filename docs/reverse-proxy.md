# FeedFerret hinter einem Reverse Proxy betreiben

FeedFerret läuft standardmäßig auf Port 3000 und erwartet, dass ein Reverse Proxy HTTPS terminiert und die korrekten Header weiterleitet. Diese Anleitung zeigt Konfigurationen für **Nginx**, **Caddy** und **Traefik**.

---

## Voraussetzung: `AUTH_TRUST_HOST=true`

Da FeedFerret hinter einem Proxy betrieben wird, muss Next-Auth angewiesen werden, den `X-Forwarded-Host`-Header des Proxys zu vertrauen. Ohne diese Variable schlägt die CSRF-Prüfung fehl und Logins sind nicht möglich.

```env
AUTH_TRUST_HOST=true
```

Diese Variable ist in `.env.example` bereits enthalten und in `docker-compose.yaml` standardmäßig auf `true` gesetzt.

---

## Nginx

### Mit Let's Encrypt (Certbot)

```nginx
# /etc/nginx/sites-available/feedferret

server {
    listen 80;
    server_name rss.example.com;

    # Let's Encrypt HTTP-Challenge
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    # Alle anderen Anfragen auf HTTPS umleiten
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

    # Moderne TLS-Einstellungen
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    # HSTS (FeedFerret setzt diesen Header nicht selbst)
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        proxy_pass http://localhost:3000;

        # Pflicht-Header für Next-Auth und korrekte URL-Erkennung
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket-Unterstützung (für zukünftige Realtime-Features)
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Timeouts für lange Sync-Anfragen
        proxy_read_timeout 120s;
        proxy_connect_timeout 10s;
    }
}
```

**Zertifikat erstellen:**

```bash
certbot --nginx -d rss.example.com
```

---

### Docker-Netzwerk (FeedFerret im selben Compose-Stack)

Wenn Nginx ebenfalls als Docker-Container läuft und sich im selben Netzwerk befindet, den `proxy_pass` auf den Service-Namen statt `localhost` zeigen lassen:

```nginx
proxy_pass http://feedferret:3000;
```

---

## Caddy

Caddy bezieht und erneuert Let's Encrypt-Zertifikate vollautomatisch.

### Caddyfile

```caddy
rss.example.com {
    reverse_proxy localhost:3000 {
        header_up Host              {host}
        header_up X-Real-IP         {remote_host}
        header_up X-Forwarded-For   {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    # HSTS (FeedFerret setzt diesen Header nicht selbst)
    header Strict-Transport-Security "max-age=31536000; includeSubDomains"

    # WebSocket-Upgrade automatisch weitergeleitet durch Caddy — kein Extra-Config nötig
}
```

### Docker-Netzwerk

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

### Caddy als Docker-Service zum FeedFerret-Stack hinzufügen

```yaml
# Ergänzung in docker-compose.yaml

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

### Docker Labels (empfohlene Methode für Docker-Setups)

Traefik-Labels direkt im `feedferret`-Service in `docker-compose.yaml` hinzufügen:

```yaml
services:
  feedferret:
    # ... bestehende Konfiguration ...
    labels:
      - "traefik.enable=true"

      # Router: HTTPS
      - "traefik.http.routers.feedferret.rule=Host(`rss.example.com`)"
      - "traefik.http.routers.feedferret.entrypoints=websecure"
      - "traefik.http.routers.feedferret.tls=true"
      - "traefik.http.routers.feedferret.tls.certresolver=letsencrypt"

      # Router: HTTP → HTTPS-Weiterleitung
      - "traefik.http.routers.feedferret-http.rule=Host(`rss.example.com`)"
      - "traefik.http.routers.feedferret-http.entrypoints=web"
      - "traefik.http.routers.feedferret-http.middlewares=redirect-to-https"

      # Middleware: HTTP-Weiterleitung
      - "traefik.http.middlewares.redirect-to-https.redirectscheme.scheme=https"
      - "traefik.http.middlewares.redirect-to-https.redirectscheme.permanent=true"

      # Middleware: HSTS (FeedFerret setzt diesen Header nicht selbst)
      - "traefik.http.middlewares.feedferret-hsts.headers.stsSeconds=31536000"
      - "traefik.http.middlewares.feedferret-hsts.headers.stsIncludeSubdomains=true"
      - "traefik.http.routers.feedferret.middlewares=feedferret-hsts"

      # Service: Port
      - "traefik.http.services.feedferret.loadbalancer.server.port=3000"

    networks:
      - feedferret_net
      - traefik_proxy   # externes Traefik-Netzwerk
```

> **Netzwerk-Hinweis:** Traefik muss Zugriff auf das `feedferret_net`-Netzwerk haben, oder FeedFerret muss dem externen Traefik-Netzwerk beitreten. Das externe Netzwerk in `docker-compose.yaml` als `external: true` deklarieren:

```yaml
networks:
  feedferret_net:
    driver: bridge
  traefik_proxy:
    external: true
```

### Traefik Static Configuration (traefik.yaml)

Mindest-Konfiguration für Traefik mit Let's Encrypt:

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

## Gemeinsame Hinweise für alle Proxys

### `AUTH_URL` korrekt setzen

`AUTH_URL` in `.env` muss exakt der öffentlich erreichbaren URL entsprechen — inklusive `https://`, ohne abschließenden Schrägstrich:

```env
AUTH_URL="https://rss.example.com"
```

### Port in Docker Compose ausblenden

Wenn ein Reverse Proxy vor FeedFerret geschaltet ist, muss Port 3000 nicht mehr am Host exponiert werden. Den `ports`-Eintrag im `feedferret`-Service entfernen oder auskommentieren, damit der Port nur intern im Docker-Netzwerk erreichbar ist:

```yaml
services:
  feedferret:
    # ports:         # auskommentiert: nur intern erreichbar
    #   - "3000:3000"
    expose:
      - "3000"       # Port im internen Netzwerk bekannt machen
```

### HSTS

FeedFerret setzt den `Strict-Transport-Security`-Header nicht selbst. Alle Konfigurationsbeispiele in dieser Anleitung enthalten den Header mit einer Gültigkeit von einem Jahr (`max-age=31536000`). Bei erstmaligem Einsatz empfiehlt sich ein kürzerer Testwert (z. B. `max-age=300`), um Sperren bei Fehlkonfiguration zu vermeiden.

### WebSocket

FeedFerret nutzt WebSockets aktuell nicht produktiv, aber die Konfigurationen in dieser Anleitung leiten `Upgrade`-Verbindungen korrekt weiter — das gewährleistet Kompatibilität, sobald Realtime-Features hinzukommen.
