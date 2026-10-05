FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json tsconfig.base.json ./
COPY vendor ./vendor
COPY packages ./packages
COPY apps/agent ./apps/agent
COPY apps/eval ./apps/eval
COPY scenarios ./scenarios
RUN pnpm install --frozen-lockfile --filter @aio/agent... --filter @aio/eval...
RUN pnpm turbo run build --filter @aio/agent... --filter @aio/eval...
RUN pnpm deploy --filter @aio/agent --prod /out --legacy

FROM node:22-bookworm-slim
ENV NODE_ENV=production AGENT_HOST=0.0.0.0 AGENT_PORT=4600
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /repo/apps/agent/dist ./dist
USER node
EXPOSE 4600
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.AGENT_PORT||4600)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main.js"]
