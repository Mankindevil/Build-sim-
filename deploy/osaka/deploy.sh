#!/usr/bin/env bash
set -Eeuo pipefail

umask 027

APP_DIR="${BUILD_SIM_APP_DIR:-/home/linuxuser/Code/build-sim}"
TARGET_REF=""
HEALTH_ATTEMPTS="${BUILD_SIM_HEALTH_ATTEMPTS:-20}"
HEALTH_DELAY_SECONDS="${BUILD_SIM_HEALTH_DELAY_SECONDS:-2}"

usage() {
  printf '%s\n' "Usage: deploy/osaka/deploy.sh [--ref <git-ref>]"
  printf '%s\n' "  --ref  Fetch origin/main and deploy this commit after verifying it belongs to origin/main."
}

while (($#)); do
  case "$1" in
    --ref)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      TARGET_REF="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$HEALTH_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || { printf '%s\n' "BUILD_SIM_HEALTH_ATTEMPTS must be a positive integer" >&2; exit 2; }
[[ "$HEALTH_DELAY_SECONDS" =~ ^[1-9][0-9]*$ ]] || { printf '%s\n' "BUILD_SIM_HEALTH_DELAY_SECONDS must be a positive integer" >&2; exit 2; }

cd "$APP_DIR"
APP_DIR="$(pwd -P)"
COMPOSE_FILE="$APP_DIR/deploy/osaka/compose.yaml"

[[ -f "$COMPOSE_FILE" ]] || { printf 'Compose file not found: %s\n' "$COMPOSE_FILE" >&2; exit 1; }
[[ -f "$APP_DIR/.env.remote" ]] || { printf 'Missing deployment environment: %s/.env.remote\n' "$APP_DIR" >&2; exit 1; }
[[ -d "$APP_DIR/runtime" ]] || { printf 'Missing persistent runtime directory: %s/runtime\n' "$APP_DIR" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null

if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
elif sudo -n docker info >/dev/null 2>&1; then
  DOCKER=(sudo -n docker)
else
  printf '%s\n' "Docker is unavailable; grant this deployment user Docker access or passwordless sudo for docker." >&2
  exit 1
fi
COMPOSE=("${DOCKER[@]}" compose -f "$COMPOSE_FILE")

PREVIOUS_SHA="$(git rev-parse HEAD)"
TARGET_SHA="$PREVIOUS_SHA"
SOURCE_CHANGED=0
RELEASE_STARTED=0
HAS_WEB_ROLLBACK=0
HAS_RUNTIME_ROLLBACK=0

restore_previous_release() {
  local original_status=$?
  trap - ERR INT TERM
  if ((SOURCE_CHANGED || RELEASE_STARTED)); then
    printf '%s\n' "Deployment failed; restoring the previous release..." >&2
    if ((SOURCE_CHANGED)); then
      git checkout --detach "$PREVIOUS_SHA" >/dev/null 2>&1 || true
    fi
  fi
  if ((RELEASE_STARTED)); then
    if ((HAS_WEB_ROLLBACK)); then
      "${DOCKER[@]}" image tag build-sim-web:rollback build-sim-web:osaka >/dev/null 2>&1 || true
    fi
    if ((HAS_RUNTIME_ROLLBACK)); then
      "${DOCKER[@]}" image tag build-sim-runtime:rollback build-sim-runtime:osaka >/dev/null 2>&1 || true
    fi
    "${COMPOSE[@]}" up -d --force-recreate >&2 || true
    "${COMPOSE[@]}" ps >&2 || true
  fi
  exit "$original_status"
}
trap restore_previous_release ERR INT TERM

if [[ -n "$TARGET_REF" ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    printf '%s\n' "Refusing to update a production checkout with tracked local changes." >&2
    exit 1
  fi
  git fetch --prune origin main
  TARGET_SHA="$(git rev-parse "${TARGET_REF}^{commit}")"
  REMOTE_MAIN_SHA="$(git rev-parse origin/main)"
  if ! git merge-base --is-ancestor "$TARGET_SHA" "$REMOTE_MAIN_SHA"; then
    printf 'Refusing to deploy %s because it is not contained in origin/main.\n' "$TARGET_SHA" >&2
    exit 1
  fi
  if [[ "$TARGET_SHA" != "$PREVIOUS_SHA" ]]; then
    git checkout --detach "$TARGET_SHA"
    SOURCE_CHANGED=1
  fi
fi

"${COMPOSE[@]}" config --quiet

if "${DOCKER[@]}" image inspect build-sim-web:osaka >/dev/null 2>&1; then
  "${DOCKER[@]}" image tag build-sim-web:osaka build-sim-web:rollback
  HAS_WEB_ROLLBACK=1
fi
if "${DOCKER[@]}" image inspect build-sim-runtime:osaka >/dev/null 2>&1; then
  "${DOCKER[@]}" image tag build-sim-runtime:osaka build-sim-runtime:rollback
  HAS_RUNTIME_ROLLBACK=1
fi

RELEASE_STARTED=1
"${COMPOSE[@]}" build
"${COMPOSE[@]}" up -d --force-recreate

healthcheck() {
  curl --fail --silent --show-error --output /dev/null http://127.0.0.1:15176/healthz \
    && curl --fail --silent --show-error --output /dev/null http://127.0.0.1:5174/api/price/health \
    && curl --fail --silent --show-error --output /dev/null http://127.0.0.1:5175/api/agent/health \
    && curl --fail --silent --show-error --output /dev/null http://127.0.0.1:5176/api/workspace/plans \
    && curl --fail --silent --show-error --output /dev/null http://127.0.0.1:18080/
}

healthy=0
for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1)); do
  if healthcheck; then
    healthy=1
    break
  fi
  sleep "$HEALTH_DELAY_SECONDS"
done

if ((healthy == 0)); then
  "${COMPOSE[@]}" logs --tail=120 >&2 || true
  printf 'Health checks failed after %s attempts.\n' "$HEALTH_ATTEMPTS" >&2
  false
fi

"${COMPOSE[@]}" ps
RELEASE_STARTED=0
trap - ERR INT TERM
printf 'Deployment succeeded: %s\n' "$TARGET_SHA"
