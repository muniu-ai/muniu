# syntax=docker/dockerfile:1.7
# SPDX-License-Identifier: Apache-2.0
# Disposable test fixture only. Upstream release binaries are no longer distributed.

FROM golang:1.24.2-bookworm@sha256:79390b5e5af9ee6e7b1173ee3eac7fadf6751a545297672916b59bfa0ecf6f71 AS minio-build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /src
ADD --checksum=sha256:7eb30a913fea30f18069abf194e1e78e4983b558cc526911ae1c11396a9859a5 https://codeload.github.com/minio/minio/tar.gz/0d7408fc9969caf07de6a8c3a84f9fbb10a6739e /tmp/minio.tar.gz
RUN mkdir -p /out && tar -xzf /tmp/minio.tar.gz --strip-components=1 -C /src && rm /tmp/minio.tar.gz
RUN --mount=type=cache,id=mn-minio-modules,target=/go/pkg/mod,sharing=locked \
    --mount=type=cache,id=mn-minio-build,target=/root/.cache/go-build,sharing=locked \
    go build -mod=readonly -trimpath -buildvcs=false -tags kqueue \
      -ldflags='-s -w -X github.com/minio/minio/cmd.Version=2025-04-22T22:12:26Z -X github.com/minio/minio/cmd.ReleaseTag=RELEASE.2025-04-22T22-12-26Z -X github.com/minio/minio/cmd.CommitID=0d7408fc9969caf07de6a8c3a84f9fbb10a6739e -X github.com/minio/minio/cmd.ShortCommitID=0d7408fc9969 -X github.com/minio/minio/cmd.CopyrightYear=2025' \
      -o /out/minio . \
    && /out/minio --version

FROM golang:1.24.2-bookworm@sha256:79390b5e5af9ee6e7b1173ee3eac7fadf6751a545297672916b59bfa0ecf6f71 AS mc-build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /src
ADD --checksum=sha256:4cd13e34daeeb8481c3ba8686b082f161b8dc1f7aad52d715a706a587349c6ae https://codeload.github.com/minio/mc/tar.gz/b00526b153a31b36767991a4f5ce2cced435ee8e /tmp/mc.tar.gz
RUN mkdir -p /out && tar -xzf /tmp/mc.tar.gz --strip-components=1 -C /src && rm /tmp/mc.tar.gz
RUN --mount=type=cache,id=mn-minio-modules,target=/go/pkg/mod,sharing=locked \
    --mount=type=cache,id=mn-minio-build,target=/root/.cache/go-build,sharing=locked \
    go build -mod=readonly -trimpath -buildvcs=false -tags kqueue \
      -ldflags='-s -w -X github.com/minio/mc/cmd.Version=2025-04-16T18:13:26Z -X github.com/minio/mc/cmd.ReleaseTag=RELEASE.2025-04-16T18-13-26Z -X github.com/minio/mc/cmd.CommitID=b00526b153a31b36767991a4f5ce2cced435ee8e -X github.com/minio/mc/cmd.ShortCommitID=b00526b153a31 -X github.com/minio/mc/cmd.CopyrightYear=2025' \
      -o /out/mc . \
    && /out/mc --version

FROM busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e
ENV HOME=/root MC_CONFIG_DIR=/tmp/.mc SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
COPY --from=minio-build /out/minio /usr/local/bin/minio
COPY --from=mc-build /out/mc /usr/local/bin/mc
COPY --from=minio-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=minio-build /src/LICENSE /usr/share/licenses/minio/LICENSE
COPY --from=mc-build /src/LICENSE /usr/share/licenses/mc/LICENSE
EXPOSE 9000
ENTRYPOINT ["minio"]
CMD ["server", "/data"]
