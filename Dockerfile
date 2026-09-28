# Production image for Cartovum Bulk Product Manager.
# Build stage: installs everything (the build needs Vite, a dev dependency), builds, then drops dev dependencies.
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build && npm prune --omit=dev && npm cache clean --force

# Runtime stage: only the built app, production dependencies and the Prisma schema + migrations.
FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=build /app/prisma/migrations ./prisma/migrations
EXPOSE 3000
# Applies migrations, then starts the server (and its background worker).
CMD ["npm", "run", "docker-start"]
