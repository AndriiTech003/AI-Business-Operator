FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json tsconfig.base.json ./
COPY vendor ./vendor
COPY packages/contracts ./packages/contracts
COPY apps/console ./apps/console
RUN pnpm install --frozen-lockfile --filter @aio/console...
RUN pnpm --filter @aio/console build

FROM nginx:1.29-alpine
COPY infra/nginx/console.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/console/dist /usr/share/nginx/html
COPY infra/nginx/config.json.template /etc/nginx/templates/config.json.template
CMD ["/bin/sh", "-c", "envsubst < /etc/nginx/templates/config.json.template > /usr/share/nginx/html/config.json && nginx -g 'daemon off;'"]
