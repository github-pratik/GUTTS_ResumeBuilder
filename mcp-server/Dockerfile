# Base image ships Chromium/Firefox/WebKit + all their OS-level dependencies already
# installed, matched to a specific Playwright npm package version. IMPORTANT: this tag's
# version must match the "playwright" version resolved in package-lock.json (currently
# 1.63.0) - Playwright is strict about the browser binary revision matching the npm
# package exactly. If you bump the playwright dependency, bump this tag to match.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

# Install dependencies first (better layer caching - this layer only invalidates when
# package.json/package-lock.json change, not on every source edit).
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
