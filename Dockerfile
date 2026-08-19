# syntax=docker/dockerfile:1.7
FROM node:22.19.0-bookworm-slim AS build
RUN npm install --global npm@11.10.1
WORKDIR /opt/muniu
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY vendor ./vendor
COPY config ./config
COPY tsconfig.base.json ./
RUN npm ci && npm run build

FROM node:22.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /opt/muniu
RUN groupadd --gid 10001 muniu && useradd --uid 10001 --gid muniu --no-create-home --shell /usr/sbin/nologin muniu
COPY --from=build --chown=10001:10001 /opt/muniu /opt/muniu
USER 10001:10001
EXPOSE 7318
ENTRYPOINT ["node"]
CMD ["apps/api/dist/index.js"]
