# The hosted MCP server (qu4zr-mcp serve-http), at https://api.management.qu4zr.io/mcp.
#
# Built from this folder's source, not pulled from npm: the image a deploy ships is the commit that
# was tested, and a compromised registry account cannot change what runs here.
#
# Runs as the image's unprivileged `node` user with a read-only root filesystem (see compose): the
# server holds no secret and writes nothing, so there is nothing for it to write.

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
CMD ["node", "dist/index.js", "serve-http"]
