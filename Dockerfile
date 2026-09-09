# ---- Build ----
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime ----
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY web ./web

RUN mkdir -p /data
ENV DATA_FILE=/data/store.db
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", "dist/index.js"]