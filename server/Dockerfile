FROM node:20-alpine

WORKDIR /app

# Copy manifests first for layer caching
COPY package.json package-lock.json* ./

# Skip Prisma postinstall generate; generate runs explicitly below
ENV PRISMA_SKIP_POSTINSTALL_GENERATE=true
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# Copy Prisma schema and source code
COPY prisma ./prisma
COPY src ./src
RUN DATABASE_URL="postgresql://placeholder" npx prisma generate

# Copy client directory so static client is served under /client or ../client
WORKDIR /
COPY ../client ./client

WORKDIR /app
EXPOSE 8080
CMD ["sh", "-c", "npx prisma db push --skip-generate && node prisma/seed.js && node src/index.js"]
