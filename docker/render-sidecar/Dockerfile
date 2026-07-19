# FeedFerret browser-render sidecar (M7-T2).
# Built on the official Playwright image, which ships a matching Chromium and
# all its system dependencies — no `playwright install` needed at build time.
FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./

ENV SIDECAR_PORT=8080
EXPOSE 8080

# Runs as the image's non-root `pwuser`.
USER pwuser
CMD ["node", "server.mjs"]
