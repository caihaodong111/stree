# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY backend backend
COPY frontend frontend
COPY packages packages
# Only public browser configuration is consumed during compilation.
RUN --mount=type=secret,id=frontend_env,target=/app/frontend/.env.production,required=true npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production APP_HOST=0.0.0.0 APP_PORT=8000 SETTINGS_ENABLED=false STORAGE_DRIVER=file
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/backend/package.json backend/package.json
COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/frontend/package.json frontend/package.json
COPY --from=build /app/frontend/dist frontend/dist
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
RUN mkdir -p backend/.runtime && chown node:node backend/.runtime
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8000/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "backend/dist/main.js"]
