# Jarvis backend — multi-stage build.
FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install --include=dev

FROM deps AS build
COPY . .
RUN npx prisma generate
RUN npm run build

FROM base AS runtime
# Playwright's chromium needs these system libraries to launch headless.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2 libpango-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*

# Reuse the full install from the build stage (including the Prisma CLI,
# needed at container start to run migrations) rather than a fresh
# --omit=dev install, which would drop the `prisma` CLI package.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY prisma ./prisma
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

RUN npx playwright install --with-deps chromium

RUN mkdir -p /app/data/workspace
VOLUME ["/app/data"]

EXPOSE 4000
ENTRYPOINT ["./docker-entrypoint.sh"]
