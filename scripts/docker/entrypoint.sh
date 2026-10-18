#!/usr/bin/env bash
set -euo pipefail

# Ensure Playwright uses preinstalled browsers
export PLAYWRIGHT_BROWSERS_PATH=0

SCRIPT_DIR="/usr/src/microsoft-rewards-script"

# 1. Timezone: default to UTC if not provided
: "${TZ:=UTC}"
export TZ
ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime
echo "$TZ" > /etc/timezone
dpkg-reconfigure -f noninteractive tzdata

# 2. Validate CRON_SCHEDULE (not required in API mode)
if [ "${API_MODE:-false}" != "true" ]; then
  if [ -z "${CRON_SCHEDULE:-}" ]; then
    echo "ERROR: CRON_SCHEDULE environment variable is not set." >&2
    echo "Please set CRON_SCHEDULE (e.g., \"0 2 * * *\")." >&2
    echo "       To run the API server instead, set API_MODE=true." >&2
    exit 1
  fi
fi

mapfile -t account_indexes < <(
  compgen -e | sed -n 's/^ACCOUNT_\([1-9][0-9]*\)_EMAIL$/\1/p' | sort -n -u
)

acct_count=0
for i in "${account_indexes[@]}"; do
  email_var="ACCOUNT_${i}_EMAIL"
  [ -z "${!email_var:-}" ] && continue

  acct_count=$((acct_count + 1))
done

if [ "$acct_count" -eq 0 ]; then
  echo "WARNING: No ACCOUNT_N_EMAIL found in environment - the script will fail." >&2
  echo "         Set at least one ACCOUNT_N_EMAIL in your .env file." >&2
else
  echo "[entrypoint] Found $acct_count account(s) in environment"
fi

CONFIG_FILE="$SCRIPT_DIR/config/config.json"
CONFIG_EXAMPLE="$SCRIPT_DIR/config.example.json"

if ! [ -f "$CONFIG_EXAMPLE" ]; then
  echo "ERROR: config.example.json not found at $CONFIG_EXAMPLE - image may be corrupt." >&2
  exit 1
fi

if [ -d "$CONFIG_FILE" ]; then
  echo "ERROR: $CONFIG_FILE is a directory, not a file." >&2
  echo "       ./config.json likely did not exist on the host when the container" >&2
  echo "       started, so Docker created it as a folder. Remove it and create the" >&2
  echo "       file first:  cp config.example.json config.json" >&2
  exit 1
fi

SYNC_ARGS=(--config "$CONFIG_FILE" --example "$CONFIG_EXAMPLE")
if [ "${CONFIG_AUTO_SYNC:-false}" = "true" ]; then
  SYNC_ARGS+=(--patch)
fi
if ! node "$SCRIPT_DIR/dist/util/ConfigSync.js" sync "${SYNC_ARGS[@]}"; then
  echo "ERROR: config sync failed - see above." >&2
  exit 1
fi

echo "[entrypoint] Applying CONFIG_* environment variable overrides..."
if ! node "$SCRIPT_DIR/dist/util/ConfigEnvOverrides.js" apply --config "$CONFIG_FILE"; then
  echo "ERROR: applying CONFIG_* overrides failed - see above." >&2
  exit 1
fi

echo "[entrypoint] Config ready."

if [ -n "${TASK_RUN_USER:-}" ]; then
  id "$TASK_RUN_USER" >/dev/null
  mkdir -p "$SCRIPT_DIR/sessions" "$SCRIPT_DIR/reports"
  chown "$TASK_RUN_USER" "$SCRIPT_DIR/sessions" "$SCRIPT_DIR/reports" "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
fi

# Link the generated config back to the root so the app script can find it
ln -sf "$CONFIG_FILE" "$SCRIPT_DIR/config.json"

# Snapshot the full container environment for cron-spawned runs
export -p > /etc/container_env
chmod 600 /etc/container_env

if [ "${RUN_ON_START:-false}" = "true" ] || [ "${DAILY_CATCH_UP:-true}" = "true" ]; then
  echo "[entrypoint] Starting initial run in background at $(date)"
  (
    cd "$SCRIPT_DIR" || {
      echo "[entrypoint-bg] ERROR: Unable to cd to $SCRIPT_DIR" >&2
      exit 1
    }
    if [ "${RUN_ON_START:-false}" = "true" ]; then
      SKIP_RANDOM_SLEEP=true scripts/docker/run_daily.sh
    else
      DAILY_TRIGGER=catchup SKIP_RANDOM_SLEEP=true scripts/docker/run_daily.sh
    fi
    echo "[entrypoint-bg] Initial run completed at $(date)"
  ) &
  echo "[entrypoint] Background process started (PID: $!)"
fi

: "${API_HOST:=0.0.0.0}"
export API_HOST

if [ "${API_MODE:-false}" = "true" ]; then
  export TZ

  node scripts/api/apply-schedule.js
  cron -f &
  echo "[entrypoint] Cron started in background (TZ: $TZ)"
  echo "[entrypoint] Starting control API on ${API_HOST}:${API_PORT:-3010} at $(date)"
  exec node scripts/api/server.js
fi

# Use the same effective schedule as the catch-up checker, including persisted overrides.
node scripts/api/apply-schedule.js
echo "[entrypoint] Cron configured (TZ: $TZ); starting cron at $(date)"
exec cron -f
