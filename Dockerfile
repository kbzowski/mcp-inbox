# Debian slim, not Alpine: sqlite-vec ships no musl binary.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts skips the lefthook "prepare" hook (no git in the image).
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    IMAP_CACHE_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
# MCP over stdio: run with `docker run -i` (no -t).
ENTRYPOINT ["node", "dist/index.js"]
