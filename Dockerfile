# ─── 1. Build stage ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# ─── 2. Production runtime stage ─────────────────────────────────────────────
FROM node:22-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install only production dependencies and clean cache
RUN npm ci --omit=dev && npm cache clean --force

# Install Playwright Chromium and minimal system dependencies, then purge apt cache
RUN npx playwright install --with-deps chromium && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/*

# Copy compiled JavaScript output from builder stage
COPY --from=builder /app/dist ./dist

# Start directly with Node (no npm process wrapper) with strict V8 heap cap & exposed GC
CMD ["node", "--max-old-space-size=350", "--expose-gc", "dist/index.js"]

