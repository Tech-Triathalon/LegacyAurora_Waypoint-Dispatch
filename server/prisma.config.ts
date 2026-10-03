// Prisma configuration — replaces the deprecated `package.json#prisma` block.
// Ref: https://pris.ly/prisma-config
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node prisma/seed.js',
  },
});
