FROM mcr.microsoft.com/playwright:v1.43.0-jammy

# Install Node.js 22 (required for node:sqlite DatabaseSync)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install project dependencies
RUN npm install

# Download Chromium browser binary for Playwright
RUN npx playwright install chromium

# Copy remaining application source code
COPY . .

# Build TypeScript to JavaScript in dist/
RUN npm run build

# Start bot service
CMD ["npm", "run", "start"]

