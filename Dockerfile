FROM node:22-alpine

# tini gives us correct signal handling, so SIGTERM reaches node and the
# engine gets to flush its state + print the final match report on shutdown
RUN apk add --no-cache tini wget

WORKDIR /app

COPY package.json package-lock.json* ./
# ci for a reproducible install; fall back if the lock drifts
RUN npm ci --omit=dev --no-audit --no-fund \
 || npm install --omit=dev --no-audit --no-fund

COPY server.js engine.js ./
COPY proto ./proto
COPY public ./public

# state/ is bind-mounted so the ledger and sim bars survive container replacement
RUN mkdir -p /app/state

ENV NODE_ENV=production \
    PORT=5173 \
    HOST=0.0.0.0 \
    REPORT_MIN=30 \
    TZ=UTC

EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5173/healthz > /dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
