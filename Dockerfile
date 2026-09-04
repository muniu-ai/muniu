# syntax=docker/dockerfile:1.7

FROM node:22.19.0-bookworm-slim AS build
RUN npm install --global npm@11.10.1
WORKDIR /opt/muniu
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY plugins ./plugins
COPY vendor ./vendor
COPY scripts ./scripts
RUN npm ci --ignore-scripts \
  && node scripts/build-v2-runtime.mjs \
  && npm prune --omit=dev --ignore-scripts

FROM node:22.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MN_RUNTIME_PROFILE=enterprise \
    MN_HOST_BIND=0.0.0.0 \
    MN_HOST_PORT=7318 \
    MN_POSTGRES_SCHEMA=mn_v2 \
    MN_S3_PREFIX=v2/ \
    MN_JOB_LEASE_MS=30000 \
    MN_TELEMETRY_ENABLED=false
WORKDIR /opt/muniu
RUN groupadd --gid 10001 muniu \
  && useradd --uid 10001 --gid muniu --no-create-home --shell /usr/sbin/nologin muniu
COPY --from=build --chown=10001:10001 /opt/muniu /opt/muniu
USER 10001:10001
EXPOSE 7318
ENTRYPOINT ["node"]
CMD ["scripts/enterprise-host.mjs"]
