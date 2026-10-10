# The log service gateway (Postgres backend). Build from the repository root:
#   docker build -f crates/log-server/Dockerfile -t mdbase-next-logsvc .
# Configuration is by environment (see crates/log-server/src/main.rs):
#   PORT or LOGSVC_LISTEN, LOGSVC_BACKEND=pg, LOGSVC_PG_URL (sslmode=require),
#   LOGSVC_PUBLIC_BASE (https), LOGSVC_OBJECTS_DIR, LOGSVC_POOL,
#   LOGSVC_ROOT_KEYS, LOGSVC_TOKEN_ISSUERS, LOGSVC_URL_SECRET (secrets).
# Probes: GET /health (liveness), GET /ready (database), GET /metrics (Prometheus).
FROM rust:1.94-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p mdbn-log-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 \
 && rm -rf /var/lib/apt/lists/* && useradd --system --uid 10001 logsvc
COPY --from=build /src/target/release/mdbn-log-server /usr/local/bin/logsvc
USER logsvc
ENV LOGSVC_BACKEND=pg
EXPOSE 10000
ENTRYPOINT ["/usr/local/bin/logsvc"]
