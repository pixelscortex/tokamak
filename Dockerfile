FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils unzip build-essential pkg-config git && rm -rf /var/lib/apt/lists/*
ENV PROTO_HOME=/root/.proto
ENV PATH=/root/.proto/bin:/root/.proto/shims:/root/.cargo/bin:$PATH
# Match .ci/setup/action.yml; tool versions come from .prototools.
ARG TARGETARCH
RUN case "$TARGETARCH" in arm64) triple=aarch64-unknown-linux-gnu ;; amd64) triple=x86_64-unknown-linux-gnu ;; *) exit 1 ;; esac \
    && asset="proto_cli-$triple.tar.xz" \
    && url="https://github.com/moonrepo/proto/releases/download/v0.62.3/$asset" \
    && curl -fsSL "$url" -o "/tmp/$asset" \
    && curl -fsSL "$url.sha256" -o /tmp/proto.sha256 \
    && cd /tmp && sha256sum -c proto.sha256 \
    && mkdir -p /root/.proto/bin /tmp/proto \
    && tar -xJf "$asset" -C /tmp/proto --strip-components=1 \
    && cp /tmp/proto/proto /tmp/proto/proto-shim /root/.proto/bin/
WORKDIR /src
COPY .prototools rust-toolchain.toml ./
RUN proto install bun && proto install rust
COPY . .
RUN proto run bun -- install --frozen-lockfile --network-concurrency=16 --verbose
RUN proto run bun -- run --cwd app build \
    && proto run bun -- packages/build/src/build.ts plugins/chat \
    && proto run bun -- packages/build/src/stage-server-plugin.ts plugins/chat/dist /src/cloud-plugins/chat
RUN bash .ci/check.sh cloud-graph \
    && proto run rust -- build --locked --release --no-default-features -p server -p tokamak-plugin-host

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home tokamak \
    && mkdir /data && chown tokamak:tokamak /data
COPY --from=build /src/target/release/tokamak-server /usr/local/bin/tokamak-server
COPY --from=build /src/target/release/tokamak-plugin-host /usr/local/bin/tokamak-plugin-host
COPY --from=build /src/app/dist /opt/tokamak/web
COPY --from=build /src/cloud-plugins /opt/tokamak/plugins
ENV PORT=3000 TOKAMAK_WEB_DIR=/opt/tokamak/web
USER tokamak
EXPOSE ${PORT}
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD curl --fail --silent "http://127.0.0.1:${PORT}/health" || exit 1
ENTRYPOINT ["tokamak-server", "--plugins", "/opt/tokamak/plugins", "--data", "/data/store"]
