FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173

COPY gui ./gui
COPY scripts/export-discord-server.mjs ./scripts/export-discord-server.mjs

RUN mkdir -p /app/outputs/gui && chown -R node:node /app/outputs
USER node

EXPOSE 4173
CMD ["node", "gui/server.mjs"]
