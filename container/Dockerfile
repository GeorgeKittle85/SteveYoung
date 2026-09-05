# =============================================================================
#  px relay image — a Wisp byte relay, and nothing else.
#
#  Built for linux/amd64 (a Cloudflare Containers requirement) and sized for
#  the `lite` instance type (1/16 vCPU, 256 MiB). `wrangler deploy` builds
#  this with your local Docker and pushes it to Cloudflare's registry.
#
#  Debian slim rather than Alpine so ws's prebuilt native `bufferutil`
#  (fast WebSocket frame unmasking) loads instead of falling back to JS.
# =============================================================================
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.mjs ./
USER node
EXPOSE 8080
# Cap the V8 heap well under the 256 MiB the instance has; socket buffers live
# outside the heap and the relay holds no page data anyway.
CMD ["node", "--max-old-space-size=128", "server.mjs"]
