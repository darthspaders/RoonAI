#!/usr/bin/env bash
set -euo pipefail

# Run only against a freshly built test image. Every container has no network;
# Roon discovery is stubbed and no player, source or visualizer is configured.
image="${1:-rabbit-hole:ci}"
test_id="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$$-$(date +%s%N)"
container="rh-lock-$test_id"
volume="rh-lock-data-$test_id"
label="io.rabbit-hole.lock-recovery-test"
bootstrap="const RoonApi=require('node-roon-api'); RoonApi.prototype.start_discovery=()=>{}; require('./src/server.js')"
lock_path="/app/data/rabbit-hole.app.lock"
sentinel_path="/app/data/.ci-lock-recovery-sentinel"

container_is_owned() {
  [[ "$(docker inspect --format '{{index .Config.Labels "io.rabbit-hole.lock-recovery-test"}}' "$container" 2>/dev/null || true)" == "$test_id" ]]
}
cleanup() {
  local result=$?
  trap - EXIT
  if container_is_owned; then
    if [[ "$result" -ne 0 ]]; then docker logs "$container" >&2 || true; fi
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
  if [[ "$(docker volume inspect --format '{{index .Labels "io.rabbit-hole.lock-recovery-test"}}' "$volume" 2>/dev/null || true)" == "$test_id" ]]; then
    docker volume rm "$volume" >/dev/null 2>&1 || true
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fail() { printf '%s\n' "$*" >&2; exit 1; }

start_container() {
  local mode="$1"
  local flags=()
  if [[ "$mode" == "with-init" ]]; then flags+=(--init); fi
  docker run -d --name "$container" --label "$label=$test_id" \
    --network none --mount "type=volume,src=$volume,dst=/app/data" \
    --entrypoint node "${flags[@]}" "$image" -e "$bootstrap" >/dev/null
}
wait_for_http() {
  local description="$1"
  for attempt in $(seq 1 30); do
    if docker exec "$container" node -e \
      "Promise.all(['/', '/api/status/live'].map(async p=>{const r=await fetch('http://127.0.0.1:3777'+p,{signal:AbortSignal.timeout(3000)}); if(!r.ok)throw Error('HTTP '+r.status); if(p.startsWith('/api/'))await r.json()})).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return
    fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" != "true" ]]; then
      fail "Container exited during $description"
    fi
    sleep 1
  done
  fail "HTTP did not become healthy during $description"
}
owner_pid() {
  docker exec "$container" node -e "console.log(JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).pid)" "$lock_path"
}
check_sentinel() {
  docker exec "$container" node -e \
    "if(require('node:fs').readFileSync(process.argv[1],'utf8')!==process.argv[2])process.exit(1)" "$sentinel_path" "$test_id"
}
check_competing_owner() {
  local result output
  # A contender runs in the owner's PID namespace. A bounded timer also makes
  # an erroneous second successful startup fail instead of hanging the job.
  if output="$(docker exec "$container" node -e \
    "setTimeout(()=>process.exit(91),5000); process.env.PORT='0'; $bootstrap" 2>&1)"; then
    fail "A competing app unexpectedly exited successfully"
  else
    result=$?
  fi
  if [[ "$result" -ne 75 ]]; then
    printf '%s\n' "$output" >&2
    fail "A genuine competing app should exit 75, got $result"
  fi
  wait_for_http "live-owner exclusion"
  check_sentinel
}
force_remove() {
  container_is_owned || fail "Refusing to remove a container not owned by this test"
  docker rm -f "$container" >/dev/null
}
crash_and_restart() {
  local mode="$1" previous_pid
  previous_pid="$(owner_pid)"
  force_remove
  start_container "$mode"
  wait_for_http "forced $mode restart"
  [[ "$(owner_pid)" == "$previous_pid" ]] || fail "The test did not reproduce PID reuse for $mode"
  check_sentinel
  check_competing_owner
  printf 'Passed: forced restart with PID reuse (%s), sentinel retained, live contender refused\n' "$mode"
}

docker volume create --label "$label=$test_id" "$volume" >/dev/null
[[ "$(docker volume inspect --format '{{index .Labels "io.rabbit-hole.lock-recovery-test"}}' "$volume")" == "$test_id" ]] || fail "Test volume ownership could not be verified"

start_container "no-init"
wait_for_http "fresh no-init startup"
[[ "$(owner_pid)" == "1" ]] || fail "The no-init app should own PID 1"
docker exec "$container" node -e \
  "require('node:fs').writeFileSync(process.argv[1],process.argv[2])" "$sentinel_path" "$test_id"
check_competing_owner
crash_and_restart "no-init"

# Simulate an existing installation's original three-field lock, keeping the
# actual owner's PID and timestamp, then force-kill before it can clean up.
docker exec "$container" node -e \
  "const fs=require('node:fs'),p=process.argv[1],o=JSON.parse(fs.readFileSync(p,'utf8')); if(o.pid!==1)throw Error('Expected legacy app PID 1'); fs.writeFileSync(p,JSON.stringify({pid:o.pid,name:o.name,startedAt:o.startedAt}))" "$lock_path"
force_remove
# Legacy wall-clock comparison permits two seconds of slack; add enough time
# for that plus /proc boot-time rounding before PID 1 becomes docker-init.
sleep 4
start_container "with-init"
wait_for_http "legacy PID-1 lock with newly enabled init"
[[ "$(owner_pid)" != "1" ]] || fail "The init-enabled app must have a different PID from init"
check_sentinel
check_competing_owner
printf 'Passed: legacy PID-1 lock recovered after enabling init, sentinel retained\n'
crash_and_restart "with-init"
