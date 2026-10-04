FROM node:20-alpine

WORKDIR /app

# Copy server package manifests first for efficient layer caching
COPY server/package.json server/package-lock.json* ./server/

# Install server dependencies
WORKDIR /app/server
ENV PRISMA_SKIP_POSTINSTALL_GENERATE=true
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# Copy Prisma schema and generate client
COPY server/prisma ./prisma
COPY server/src ./src
RUN DATABASE_URL="postgresql://placeholder" npx prisma generate

# Copy client and root assets
WORKDIR /app
COPY client ./client
COPY server ./server

WORKDIR /app/server
EXPOSE 8080
CMD ["sh", "-c", "npx prisma db push --skip-generate && node prisma/seed.js && node src/index.js"]
