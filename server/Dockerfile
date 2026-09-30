FROM node:20-alpine

WORKDIR /app

# Copy manifests first for layer caching
COPY package.json package-lock.json* ./

# Skip Prisma postinstall generate (engine download at build time); generate runs explicitly below
ENV PRISMA_SKIP_POSTINSTALL_GENERATE=true
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# Copy source and generate the Prisma client (downloads query engine for linux-musl)
COPY prisma ./prisma
COPY src ./src
RUN DATABASE_URL="postgresql://placeholder" node node_modules/prisma/build/index.js generate

EXPOSE 8080
CMD ["sh", "-c", "npx prisma db push --skip-generate && node prisma/seed.js && node src/index.js"]
