FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

FROM builder AS production-deps
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV CAMOUFOX_PYTHON=/app/.venv-camoufox/bin/python

COPY package*.json ./
COPY --from=production-deps /app/node_modules ./node_modules

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-venv ca-certificates xvfb libgtk-3-0 libdbus-glib-1-2 libxt6 libx11-xcb1 libasound2 libnss3 libxss1 libxcomposite1 libxdamage1 libxrandr2 libgbm1 && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

COPY scripts/camoufox/requirements.txt /app/scripts/camoufox/requirements.txt
RUN python3 -m venv /app/.venv-camoufox && \
    /app/.venv-camoufox/bin/pip install --no-cache-dir -r /app/scripts/camoufox/requirements.txt && \
    /app/.venv-camoufox/bin/camoufox sync && \
    /app/.venv-camoufox/bin/camoufox set official/stable/152.0.4-beta.30 && \
    /app/.venv-camoufox/bin/camoufox fetch official/152.0.4-beta.30 && \
    /app/.venv-camoufox/bin/camoufox version

COPY --from=builder /app/dist ./dist
COPY scripts/camoufox/serve.py /app/scripts/camoufox/serve.py

RUN mkdir -p /app/data

CMD ["npm", "run", "start"]

# API runtime omits Python, Camoufox, and browser binaries; only the scraper
# runner needs them. This keeps API-only builds and deploys small and fast.
FROM node:22-bookworm-slim AS api-runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/data
CMD ["npm", "run", "start:api"]
