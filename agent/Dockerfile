FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS build
WORKDIR /app/agent
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
WORKDIR /app/agent
ENV NODE_ENV=production AGENT_HOST=0.0.0.0 AGENT_PORT=8102 AGENT_DATABASE=/data/session.sqlite AGENT_WORKSPACE=/workspace
COPY --from=build --chown=node:node /app/agent/package.json ./
COPY --from=build --chown=node:node /app/agent/node_modules ./node_modules
COPY --from=build --chown=node:node /app/agent/dist ./dist
COPY --chown=node:node skills ./skills
RUN mkdir -p /data /workspace && chown node:node /data /workspace
USER node
EXPOSE 8102
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=6 CMD node -e "fetch('http://127.0.0.1:8102/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
