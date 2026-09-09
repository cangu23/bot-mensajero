# ---- Build ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
# better-sqlite3 necesita las build tools para compilar nativamente en Alpine
RUN apk add --no-cache python3 make g++ \
  && npm ci --omit=dev \
  && npm cache clean --force \
  && apk del python3 make g++

COPY --from=build /app/dist ./dist
COPY web ./web

# El volumen de Fly se monta en /data
ENV DATA_FILE=/data/store.db
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", "dist/index.js"]