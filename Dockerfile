# Polymarket 5M/15M（Node 20+：fetch；WebSocket 经 undici 或 Node 22 全局）
FROM node:22-alpine

WORKDIR /app

# markets-server.mjs 仅用 Node 内置模块，无需 npm install
COPY markets-server.mjs docker-entrypoint.sh ./
COPY polymarket*.html polymarket*.js polymarket*.css ./

RUN mkdir -p /data && chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=9004
ENV HOST=0.0.0.0
ENV DATA_DIR=/data

EXPOSE 9004

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9004/api/health >/dev/null || exit 1

CMD ["./docker-entrypoint.sh"]
