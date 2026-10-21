# Cloudflare Container for the MyFitnessPal browser login and voice-note
# transcoding. Alchemy builds it for linux/amd64 (worker/src/container).
FROM node:24.19.0-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=8080

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# rebrowser-playwright's own CLI needs the test runner, so use its bundled core
# CLI. Headless only (no display here): the headless shell is what prod's
# `headless: true` launches; the full Chromium build would be dead weight.
RUN npm ci --omit=dev --ignore-scripts \
 && node node_modules/playwright-core/cli.js install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

COPY src ./src

USER node
EXPOSE 8080
CMD ["node", "src/main.ts"]
