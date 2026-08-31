#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

AUTH_ENV_FILE="${1:-}"
AUTH_FILE="${BUILD_SIM_BASIC_AUTH_FILE:-/etc/nginx/.htpasswd-build-sim}"
AUTH_OWNER="${BUILD_SIM_BASIC_AUTH_OWNER:-root}"
AUTH_GROUP="${BUILD_SIM_BASIC_AUTH_GROUP:-www-data}"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ -n "$AUTH_ENV_FILE" ]] || fail "Usage: deploy/osaka/update-basic-auth.sh <auth-env-file>"
[[ -f "$AUTH_ENV_FILE" ]] || fail "Basic-auth environment file not found: $AUTH_ENV_FILE"

AUTH_ENV_MODE="$(stat -c '%a' "$AUTH_ENV_FILE")"
[[ "$AUTH_ENV_MODE" =~ ^[0-7]00$ ]] \
  || fail "Basic-auth environment file must not be readable or writable by group/other (use chmod 600)."

AUTH_USERNAME=""
AUTH_PASSWORD=""
USERNAME_SEEN=0
PASSWORD_SEEN=0

while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ -z "$line" || "$line" == \#* ]] && continue
  [[ "$line" == *=* ]] || fail "Basic-auth environment file contains a malformed line."
  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in
    BUILD_SIM_BASIC_AUTH_USERNAME)
      ((USERNAME_SEEN == 0)) || fail "BUILD_SIM_BASIC_AUTH_USERNAME is duplicated."
      AUTH_USERNAME="$value"
      USERNAME_SEEN=1
      ;;
    BUILD_SIM_BASIC_AUTH_PASSWORD)
      ((PASSWORD_SEEN == 0)) || fail "BUILD_SIM_BASIC_AUTH_PASSWORD is duplicated."
      AUTH_PASSWORD="$value"
      PASSWORD_SEEN=1
      ;;
    *)
      fail "Basic-auth environment file contains an unsupported key: $key"
      ;;
  esac
done < "$AUTH_ENV_FILE"

((USERNAME_SEEN == 1)) || fail "BUILD_SIM_BASIC_AUTH_USERNAME is required."
((PASSWORD_SEEN == 1)) || fail "BUILD_SIM_BASIC_AUTH_PASSWORD is required."
[[ "$AUTH_USERNAME" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || fail "Basic-auth username is invalid."
(( ${#AUTH_PASSWORD} >= 16 )) || fail "Basic-auth password must contain at least 16 characters."
[[ "$AUTH_PASSWORD" != "<generate-a-strong-site-password>" ]] || fail "Replace the example basic-auth password before deployment."
[[ "$AUTH_PASSWORD" != *$'\n'* && "$AUTH_PASSWORD" != *$'\r'* ]] || fail "Basic-auth password must be one line."

command -v htpasswd >/dev/null 2>&1 || fail "htpasswd is unavailable; install apache2-utils first."

PRIVILEGED=()
if (( EUID != 0 )); then
  if sudo -n true >/dev/null 2>&1; then
    PRIVILEGED=(sudo -n)
  elif [[ -t 0 ]]; then
    PRIVILEGED=(sudo)
  else
    fail "Updating the Nginx password file requires root or non-interactive sudo access."
  fi
fi

run_privileged() {
  "${PRIVILEGED[@]}" "$@"
}

NEXT_FILE="$(mktemp)"
PREVIOUS_FILE="$(mktemp)"
PREVIOUS_EXISTS=0
INSTALLED=0

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if ((status != 0 && INSTALLED == 1)); then
    if ((PREVIOUS_EXISTS == 1)); then
      run_privileged install -o "$AUTH_OWNER" -g "$AUTH_GROUP" -m 0640 "$PREVIOUS_FILE" "$AUTH_FILE" || true
    else
      run_privileged rm -f -- "$AUTH_FILE" || true
    fi
  fi
  rm -f -- "$NEXT_FILE" "$PREVIOUS_FILE"
  AUTH_PASSWORD=""
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if run_privileged test -f "$AUTH_FILE"; then
  run_privileged cat "$AUTH_FILE" > "$PREVIOUS_FILE"
  PREVIOUS_EXISTS=1
fi

# -i keeps the password out of argv/process listings. -c creates a fresh file,
# so changing the configured username cannot leave an old login active.
printf '%s\n' "$AUTH_PASSWORD" | htpasswd -ciB "$NEXT_FILE" "$AUTH_USERNAME" >/dev/null
printf '%s\n' "$AUTH_PASSWORD" | htpasswd -vi "$NEXT_FILE" "$AUTH_USERNAME" >/dev/null

run_privileged install -o "$AUTH_OWNER" -g "$AUTH_GROUP" -m 0640 "$NEXT_FILE" "$AUTH_FILE"
INSTALLED=1
run_privileged nginx -t
run_privileged systemctl reload nginx
INSTALLED=0

printf 'Updated Nginx basic-auth account: %s\n' "$AUTH_USERNAME"
