# ---- Build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Instalar herramientas para compilar módulos nativos (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Dejar solo las dependencias de producción compiladas
RUN npm prune --omit=dev

# ---- Runtime ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY web ./web

RUN mkdir -p /data
ENV DATA_FILE=/data/store.db
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", "dist/index.js"]