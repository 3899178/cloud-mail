#!/usr/bin/env bash
set -euo pipefail
# Public Linux fixture-only pipeline. No production/release/provider credentials.
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
: "${RUNNER_TEMP:?isolated runner directory required}"
NODE_IMAGE='node:24.18.0-bookworm-slim@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6'
docker version --format '{{json .Server}}'
docker compose version
docker pull "$NODE_IMAGE"
bootstrap=$(docker create "$NODE_IMAGE")
docker cp "$bootstrap:/usr/local/bin/node" "$RUNNER_TEMP/node24"
docker rm "$bootstrap" >/dev/null
NODE="$RUNNER_TEMP/node24"
"$NODE" --version
"$NODE" --test deploy/tests/*.test.mjs
CONTEXT="$RUNNER_TEMP/context-$GITHUB_SHA"
"$NODE" deploy/build-context.mjs "$CONTEXT"
# The daemon sees only this selected context; never pass repository root.
docker build --platform linux/amd64 --target runtime --label "org.opencontainers.image.revision=$GITHUB_SHA" --label 'org.opencontainers.image.source=https://github.com/3899178/cloud-mail' -f "$CONTEXT/deploy/Dockerfile" -t cloud-mail:runtime "$CONTEXT"
docker build --platform linux/amd64 --target test -f "$CONTEXT/deploy/Dockerfile" -t cloud-mail:test "$CONTEXT"
docker run --rm --network none cloud-mail:test
docker image inspect cloud-mail:runtime --format '{{.Id}} {{json .Config.User}} {{json .Config.Entrypoint}}'
# Prove image filesystem has runtime files only. No source suites/compiler/cache.
docker run --rm --network none --entrypoint /bin/sh cloud-mail:runtime -ec 'test ! -d /app/services/proton-helper; test ! -d /app/services/mail-sync/tests; test ! -d /usr/local/go; test ! -d /root/.npm; test ! -d /app/.git; test ! -d /app/.data'
network="cloud-mail-fixture-$GITHUB_RUN_ID"
provider="cloud-mail-provider-$GITHUB_RUN_ID"
proton="cloud-mail-proton-$GITHUB_RUN_ID"
unit="cloud-mail-resource-$GITHUB_RUN_ID"
smoke="cloud-mail-smoke-$GITHUB_RUN_ID"
cleanup(){ docker rm -f "$unit" "$provider" "$proton" "$smoke" >/dev/null 2>&1 || true; docker network rm "$network" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker network create --internal "$network" >/dev/null
docker run -d --name "$provider" --network "$network" --network-alias provider-fixture --entrypoint node cloud-mail:test deploy/fixtures/imap-server.mjs >/dev/null
for attempt in $(seq 1 60); do
  if docker logs "$provider" 2>&1 | grep -q '"ready":true'; then break; fi
  test "$attempt" -lt 60
  sleep 1
done
mkdir -p "$RUNNER_TEMP/resource-data" "$RUNNER_TEMP/evidence" "$RUNNER_TEMP/smoke-data"
sudo chown 10001:10001 "$RUNNER_TEMP/resource-data" "$RUNNER_TEMP/evidence" "$RUNNER_TEMP/smoke-data"
docker run -d --name "$proton" --network "$network" --network-alias mail.proton.me --entrypoint /usr/local/bin/helper-fixtures -e CLOUD_MAIL_RESOURCE_PROVIDER=1 -e CLOUD_MAIL_RESOURCE_DIR=/evidence -v "$RUNNER_TEMP/evidence:/evidence" cloud-mail:test -test.run '^TestResourceProviderChild$' >/dev/null
for attempt in $(seq 1 60); do
  if docker logs "$proton" 2>&1 | grep -q RESOURCE_PROTON_PROVIDER_READY; then break; fi
  test "$attempt" -lt 60
  sleep 1
done
common=(--user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges --memory 335544320 --memory-reservation 268435456 --memory-swap 335544320 --cpus 1 --pids-limit 96 --network "$network" --tmpfs /run/cloud-mail-proton:rw,noexec,nosuid,nodev,size=1048576,mode=0700,uid=10001,gid=10001 --tmpfs /tmp:rw,noexec,nosuid,nodev,size=8388608,mode=0700,uid=10001,gid=10001)
docker create --name "$unit" "${common[@]}" --no-healthcheck --tmpfs /limited:rw,noexec,nosuid,nodev,size=2097152,mode=0700,uid=10001,gid=10001 -v "$RUNNER_TEMP/resource-data:/data" -v "$RUNNER_TEMP/evidence:/evidence" -v "$ROOT/deploy/fixtures:/app/deploy/fixtures:ro" -e SYNTHETIC_PROVIDER_URL=http://provider-fixture:8080/ -e SSL_CERT_FILE=/evidence/proton-ca.pem -e NODE_EXTRA_CA_CERTS=/evidence/proton-ca.pem cloud-mail:runtime --node-entry /app/deploy/fixtures/resource.mjs >/dev/null
inspect_resource(){ docker inspect "$unit" --format '{"memory":{{.HostConfig.Memory}},"memorySwap":{{.HostConfig.MemorySwap}},"oomKilled":{{.State.OOMKilled}},"restarts":{{.RestartCount}},"exitCode":{{.State.ExitCode}}}'; }
# Host receipts stay outside evidence/, whose owner is container UID10001.
inspect_resource > "$RUNNER_TEMP/resource-container-before.json"
docker start "$unit" >/dev/null
code=$(docker wait "$unit")
docker logs "$unit"
docker inspect "$unit" --format 'resource-exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}} memory={{.HostConfig.Memory}} memorySwap={{.HostConfig.MemorySwap}}'
inspect_resource > "$RUNNER_TEMP/resource-container-after.json"
test "$code" = 0
test "$(docker inspect "$unit" --format '{{.State.OOMKilled}} {{.RestartCount}}')" = 'false 0'
"$NODE" deploy/fixtures/resource-memory.mjs "$RUNNER_TEMP/evidence/resource.json" "$RUNNER_TEMP/resource-container-before.json" "$RUNNER_TEMP/resource-container-after.json"
# Normal entrypoint/auth + coordinated crash/restart + stop retains user state.
export MAIL_SYNC_MASTER_KEY MAIL_SYNC_GATEWAY_KEY
MAIL_SYNC_MASTER_KEY=$(openssl rand -hex 32)
MAIL_SYNC_GATEWAY_KEY=$(openssl rand -hex 32)
docker run -d --name "$smoke" "${common[@]}" --restart on-failure:3 --network-alias cloud-mail-sync -v "$RUNNER_TEMP/smoke-data:/data" -v "$RUNNER_TEMP/evidence:/evidence" -v "$ROOT/deploy/fixtures:/app/deploy/fixtures:ro" -e MAIL_SYNC_MASTER_KEY -e MAIL_SYNC_GATEWAY_KEY -e MAIL_SYNC_PRIVATE_CONTAINER=1 cloud-mail:runtime >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$smoke" /usr/local/bin/supervisor health; then break; fi
  test "$attempt" -lt 30
  sleep 1
done
docker run --rm --network "$network" --entrypoint node cloud-mail:test -e 'const r=await fetch("http://cloud-mail-sync:3211/v1/accounts");if(r.status!==401)process.exit(1);console.log("PRIVATE_GATEWAY_401")'
docker exec "$smoke" node /app/deploy/fixtures/lifecycle.mjs seed
docker exec "$smoke" /bin/sh -ec 'for f in /proc/[0-9]*/comm; do read -r name < "$f" || continue; if [ "$name" = proton-helper ]; then pid=${f#/proc/}; pid=${pid%/comm}; kill -KILL "$pid"; exit; fi; done; exit 1'
for attempt in $(seq 1 30); do
  if test "$(docker inspect "$smoke" --format '{{.RestartCount}}')" = 1 && docker exec "$smoke" /usr/local/bin/supervisor health; then break; fi
  test "$attempt" -lt 30
  sleep 1
done
docker exec "$smoke" node /app/deploy/fixtures/lifecycle.mjs verify
docker stop --time 25 "$smoke" >/dev/null
test -s "$RUNNER_TEMP/smoke-data/mail.sqlite"
docker start "$smoke" >/dev/null
sleep 2
docker exec "$smoke" /usr/local/bin/supervisor health
docker exec "$smoke" node /app/deploy/fixtures/lifecycle.mjs verify
docker stop --time 25 "$smoke" >/dev/null
docker run --rm --network none --read-only --user 10001:10001 --entrypoint node -v "$RUNNER_TEMP/smoke-data:/data" -v "$RUNNER_TEMP/evidence:/evidence:ro" -v "$ROOT/deploy/fixtures:/app/deploy/fixtures:ro" -e MAIL_SYNC_MASTER_KEY cloud-mail:runtime /app/deploy/fixtures/lifecycle.mjs verify
"$NODE" -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1]);if(db.prepare("PRAGMA integrity_check").get().integrity_check!=="ok")process.exit(1);db.close();console.log("STOP_RESTART_SQLITE_INTEGRITY_OK")' "$RUNNER_TEMP/smoke-data/mail.sqlite"
docker image inspect cloud-mail:runtime --format 'candidate-image-id={{.Id}}'
