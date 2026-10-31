FROM --platform=linux/amd64 golang:1.27.3-bookworm@sha256:e482b31b5d30c31f9e495f4b8cbdf41429b2d74955dfbcd9c0a904483d738390 AS go-build
ENV GOTOOLCHAIN=local GOTELEMETRY=off GOPROXY=off CGO_ENABLED=0
WORKDIR /src/services/proton-helper
COPY services/proton-helper/ ./
RUN go build -mod=vendor -trimpath -ldflags='-s -w -buildid=' -o /out/proton-helper .
RUN go test -c -mod=vendor -o /out/helper-fixtures .
COPY deploy/runtime/supervisor.go /src/supervisor.go
RUN go build -trimpath -ldflags='-s -w -buildid=' -o /out/supervisor /src/supervisor.go

FROM --platform=linux/amd64 node:24.18.0-bookworm-slim@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6 AS dependencies
WORKDIR /app/services/mail-sync
COPY services/mail-sync/package.json services/mail-sync/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund && npm cache clean --force

FROM --platform=linux/amd64 node:24.18.0-bookworm-slim@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6 AS runtime
WORKDIR /app
COPY --from=go-build /out/proton-helper /out/supervisor /usr/local/bin/
COPY --from=dependencies /app/services/mail-sync/node_modules services/mail-sync/node_modules
COPY services/mail-sync/src services/mail-sync/src
COPY services/mail-sync/package.json services/mail-sync/package.json
COPY shared/unified-mail shared/unified-mail
RUN mkdir -p /data /run/cloud-mail-proton && chown -R 10001:10001 /data /run/cloud-mail-proton && chmod 700 /data /run/cloud-mail-proton
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=96 GOMEMLIMIT=24MiB GOGC=50 MAIL_SYNC_DATA_DIR=/data PROTON_HELPER_SOCKET=/run/cloud-mail-proton/helper.sock
USER 10001:10001
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 CMD ["/usr/local/bin/supervisor", "health"]
ENTRYPOINT ["/usr/local/bin/supervisor"]

# Test-only stage: never published. Includes Go/Node suites and test dependencies.
FROM dependencies AS test
WORKDIR /app
COPY --from=go-build /usr/local/go /usr/local/go
COPY --from=go-build /out/proton-helper /out/supervisor /usr/local/bin/
COPY --from=go-build /out/helper-fixtures /usr/local/bin/helper-fixtures
COPY services/proton-helper services/proton-helper
COPY services/mail-sync services/mail-sync
COPY mail-worker/package.json mail-worker/package.json
COPY shared/unified-mail shared/unified-mail
COPY deploy deploy
ENV PATH=/usr/local/go/bin:$PATH GOTOOLCHAIN=local GOTELEMETRY=off GOPROXY=off CLOUD_MAIL_TEST_NODE=/usr/local/bin/node GOCACHE=/tmp/go-cache GOPATH=/tmp/go
RUN cd services/mail-sync && npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
RUN mkdir -p /app/.data/test-tmp && chown -R 10001:10001 /app/.data && cp services/proton-helper/third_party/hydroxide/protonmail/*_test.go services/proton-helper/vendor/github.com/emersion/hydroxide/protonmail/
USER 10001:10001
ENTRYPOINT ["node", "deploy/linux-suites.mjs"]
