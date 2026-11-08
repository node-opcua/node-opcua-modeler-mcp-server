# Standalone streamable-HTTP MCP server (POST /mcp, GET /health).
# Build from the public repository root (github.com/node-opcua/node-opcua-modeler-mcp-server):
# it carries the package-lock.json that `npm ci` needs.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8807
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY catalog ./catalog
COPY server.json ./
USER node
EXPOSE 8807
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8807)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Runtime env: OPCUA_MODELER_API_KEY, OPCUA_MODELER_BACKEND, MCP_HTTP_AUTH_TOKEN, PORT
ENTRYPOINT ["node", "dist/http-cli.js"]
