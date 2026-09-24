# Test-only source builds: upstream release commits, not replacement production images.
FROM golang:1.26.7-bookworm@sha256:e8c859f5632dcfde7b32d2012b4351728f6437930887c2f6a91ea242459e5514 AS toolchain
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-mod=readonly
WORKDIR /src

FROM toolchain AS minio-build
RUN curl --fail --location --silent --show-error \
      https://codeload.github.com/minio/minio/tar.gz/07c3a429bfed433e49018cb0f78a52145d4bedeb -o /tmp/source.tar.gz \
    && echo '8819e3e7817e46b7b3798f8f200ead208562e571563c2e040352378031abe9f2  /tmp/source.tar.gz' | sha256sum --check --strict \
    && tar -xzf /tmp/source.tar.gz --strip-components=1 && rm /tmp/source.tar.gz
RUN --mount=type=cache,id=mdbase-s3-test-go126-mod,target=/go/pkg/mod --mount=type=cache,id=mdbase-s3-test-go126-build,target=/root/.cache/go-build \
    go build -p 4 -trimpath -buildvcs=false -o /out/minio . && go mod verify

FROM toolchain AS mc-build
RUN curl --fail --location --silent --show-error \
      https://codeload.github.com/minio/mc/tar.gz/7394ce0dd2a80935aded936b09fa12cbb3cb8096 -o /tmp/source.tar.gz \
    && echo '95cd293c7119f16921a6dc515a1fb74a2227f19fd994b9c8b770a154e802ac44  /tmp/source.tar.gz' | sha256sum --check --strict \
    && tar -xzf /tmp/source.tar.gz --strip-components=1 && rm /tmp/source.tar.gz
RUN --mount=type=cache,id=mdbase-s3-test-go126-mod,target=/go/pkg/mod --mount=type=cache,id=mdbase-s3-test-go126-build,target=/root/.cache/go-build \
    go build -p 4 -trimpath -buildvcs=false -o /out/mc . && go mod verify

FROM busybox:1.37.0-musl@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092 AS runtime
COPY --from=toolchain /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

FROM runtime AS minio
LABEL org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="07c3a429bfed433e49018cb0f78a52145d4bedeb"
COPY --from=minio-build /out/minio /usr/local/bin/minio
COPY --from=minio-build /src/LICENSE /licenses/minio
ENV MINIO_UPDATE=off
ENTRYPOINT ["/usr/local/bin/minio"]

FROM runtime AS mc
LABEL org.opencontainers.image.source="https://github.com/minio/mc" \
      org.opencontainers.image.revision="7394ce0dd2a80935aded936b09fa12cbb3cb8096"
COPY --from=mc-build /out/mc /usr/local/bin/mc
COPY --from=mc-build /src/LICENSE /licenses/mc
ENTRYPOINT ["/usr/local/bin/mc"]
