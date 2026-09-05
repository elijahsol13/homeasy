# ==============================================================================
# Multi-Stage Dockerfile for HomEasy (EC2 t3.micro optimized)
# ==============================================================================

# ── Stage 1: Build TypeScript Application ─────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install build dependencies
COPY package*.json tsconfig.json ./
RUN npm ci

# Copy application source code
COPY src/ ./src/

# Compile TypeScript to dist/
RUN npm run build

# Remove development dependencies to keep final image small
RUN npm prune --omit=dev

# ── Stage 2: Production Runner with Playwright Chromium ────────────────────────
FROM node:22-bookworm-slim AS runner

WORKDIR /app

# Ensure non-interactive apt installations
ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production

# Copy package manifests and production dependencies
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules

# Install system dependencies required by Chromium and install Chromium itself
RUN apt-get update && \
    npx playwright install --with-deps chromium && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Copy compiled JavaScript dist from builder stage
COPY --from=builder /app/dist ./dist

# Create persistent data directory for SQLite database and browser sessions
RUN mkdir -p /app/data

# Default command (overridden by docker-compose)
CMD ["npm", "run", "start"]
