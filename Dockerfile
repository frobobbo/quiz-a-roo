# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
RUN addgroup -S -g 1001 app && adduser -S -u 1001 -G app app && mkdir -p /data && chown -R app:app /data
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:app package*.json ./
COPY --chown=app:app server.js questions.js library.json ./
COPY --chown=app:app public ./public
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
