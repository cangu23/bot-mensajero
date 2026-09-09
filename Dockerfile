# ---- Build ----
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache libstdc++ \
  && apk add --no-cache --virtual .build-deps python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force \
  && apk del .build-deps

COPY --from=build /app/dist ./dist
COPY web ./web

RUN mkdir -p /data
ENV DATA_FILE=/data/store.db
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", "dist/index.js"]