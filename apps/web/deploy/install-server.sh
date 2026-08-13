#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
config_file="${SNAPTEX_SERVER_CONFIG:-$repo_root/apps/web/server.env}"
template_file="$repo_root/apps/web/deploy/snaptex-web.service.template"

if [[ ! -f "$config_file" ]]; then
    echo "Missing $config_file" >&2
    echo "Copy apps/web/server.env.example to apps/web/server.env and configure it first." >&2
    exit 1
fi
if ! chmod 600 "$config_file"; then
    echo "Cannot restrict $config_file to its owner." >&2
    exit 1
fi
# shellcheck source=/dev/null
source "$config_file"

: "${SNAPTEX_PROJECTS_ROOT:?Set SNAPTEX_PROJECTS_ROOT in $config_file}"
: "${SNAPTEX_AUTH_USERNAME:?Set SNAPTEX_AUTH_USERNAME in $config_file}"
: "${SNAPTEX_AUTH_PASSWORD:?Set SNAPTEX_AUTH_PASSWORD in $config_file}"
: "${SNAPTEX_PUBLIC_ORIGIN:?Set SNAPTEX_PUBLIC_ORIGIN in $config_file}"
SNAPTEX_INSTALL_DIR="${SNAPTEX_INSTALL_DIR:-/opt/snaptex-web}"
SNAPTEX_SERVICE_NAME="${SNAPTEX_SERVICE_NAME:-snaptex-web}"
SNAPTEX_RUN_USER="${SNAPTEX_RUN_USER:-snaptex}"
SNAPTEX_PUBLIC_PATH="${SNAPTEX_PUBLIC_PATH:-/}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3000}"

if [[ ! "$SNAPTEX_SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+$ ]]; then
    echo "Invalid SNAPTEX_SERVICE_NAME: $SNAPTEX_SERVICE_NAME" >&2
    exit 1
fi
if [[ "$HOST" != "127.0.0.1" && "$HOST" != "::1" && "$HOST" != "localhost" ]]; then
    echo "HOST must be loopback; expose SnapTeX through an HTTPS reverse proxy." >&2
    exit 1
fi
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
    echo "Invalid PORT: $PORT" >&2
    exit 1
fi
if [[ ! "$SNAPTEX_PUBLIC_ORIGIN" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
    echo "SNAPTEX_PUBLIC_ORIGIN must be an HTTPS origin without a path." >&2
    exit 1
fi
if [[ "$SNAPTEX_PUBLIC_PATH" != "/" && ! "$SNAPTEX_PUBLIC_PATH" =~ ^/[A-Za-z0-9._~/-]+/$ ]]; then
    echo "SNAPTEX_PUBLIC_PATH must be an absolute URL path ending in /." >&2
    exit 1
fi
if (( ${#SNAPTEX_AUTH_PASSWORD} < 16 )); then
    echo "SNAPTEX_AUTH_PASSWORD must contain at least 16 characters." >&2
    exit 1
fi
if [[ "$SNAPTEX_AUTH_USERNAME$SNAPTEX_AUTH_PASSWORD" == *$'\n'* || "$SNAPTEX_AUTH_USERNAME$SNAPTEX_AUTH_PASSWORD" == *$'\r'* ]]; then
    echo "Authentication credentials cannot contain line breaks." >&2
    exit 1
fi
if [[ ! "$SNAPTEX_RUN_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
    echo "SNAPTEX_RUN_USER must be a valid system account name." >&2
    exit 1
fi
if [[ ! -d "$SNAPTEX_PROJECTS_ROOT" ]]; then
    echo "Projects directory does not exist: $SNAPTEX_PROJECTS_ROOT" >&2
    exit 1
fi
SNAPTEX_PROJECTS_ROOT="$(realpath "$SNAPTEX_PROJECTS_ROOT")"
SNAPTEX_INSTALL_DIR="$(realpath -m "$SNAPTEX_INSTALL_DIR")"
if [[ "$SNAPTEX_INSTALL_DIR" == "/" || "$SNAPTEX_INSTALL_DIR" != /* ]]; then
    echo "SNAPTEX_INSTALL_DIR must be an absolute non-root path." >&2
    exit 1
fi
path_contains() { [[ "$2" == "$1" || "$2" == "$1"/* ]]; }
if path_contains "$SNAPTEX_INSTALL_DIR" "$SNAPTEX_PROJECTS_ROOT" || path_contains "$SNAPTEX_PROJECTS_ROOT" "$SNAPTEX_INSTALL_DIR"; then
    echo "SNAPTEX_INSTALL_DIR and SNAPTEX_PROJECTS_ROOT must be separate paths." >&2
    exit 1
fi
if [[ "$SNAPTEX_INSTALL_DIR$SNAPTEX_PROJECTS_ROOT" =~ [[:space:]] ]] || [[ "$SNAPTEX_INSTALL_DIR$SNAPTEX_PROJECTS_ROOT" == *\"* ]]; then
    echo "Deployment and project paths cannot contain whitespace or double quotes." >&2
    exit 1
fi
run_root() {
    if [[ "$(id -u)" -eq 0 ]]; then "$@"; else sudo "$@"; fi
}
escape_sed() { printf '%s' "$1" | sed 's/[\\&|]/\\&/g'; }
systemd_quote() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

if ! id "$SNAPTEX_RUN_USER" >/dev/null 2>&1; then
    echo "[SnapTeX] Creating service account $SNAPTEX_RUN_USER..."
    run_root useradd --system --user-group --create-home \
        --home-dir "/var/lib/$SNAPTEX_SERVICE_NAME" --shell /usr/sbin/nologin "$SNAPTEX_RUN_USER"
fi
if [[ "$(id -u "$SNAPTEX_RUN_USER")" -eq 0 ]]; then
    echo "SNAPTEX_RUN_USER must not be root." >&2
    exit 1
fi
if ! command -v setfacl >/dev/null 2>&1; then
    echo "setfacl is required to grant scoped project access (install the acl package)." >&2
    exit 1
fi

echo "[SnapTeX] Granting $SNAPTEX_RUN_USER access to the project tree..."
parent="$(dirname "$SNAPTEX_PROJECTS_ROOT")"
while [[ "$parent" != "/" ]]; do
    run_root setfacl -m "u:$SNAPTEX_RUN_USER:--x" "$parent"
    parent="$(dirname "$parent")"
done
run_root setfacl -R -m "u:$SNAPTEX_RUN_USER:rwX" "$SNAPTEX_PROJECTS_ROOT"
run_root find "$SNAPTEX_PROJECTS_ROOT" -type d -exec setfacl -m "d:u:$SNAPTEX_RUN_USER:rwX" {} +

echo "[SnapTeX] Installing dependencies and building the Web app..."
cd "$repo_root"
(
    unset SNAPTEX_AUTH_USERNAME SNAPTEX_AUTH_PASSWORD
    npm ci
    npm run web:build-static
    npm run web:test-server
)

node_bin="$(command -v node)"
run_group="$(id -gn "$SNAPTEX_RUN_USER")"
temp_dir="$(mktemp -d)"
unit_file="$temp_dir/$SNAPTEX_SERVICE_NAME.service"
environment_file="$temp_dir/server.env"
verify_log="$temp_dir/systemd-verify.log"
unit_target="/etc/systemd/system/$SNAPTEX_SERVICE_NAME.service"
environment_target="/etc/$SNAPTEX_SERVICE_NAME.env"
next_dir="$SNAPTEX_INSTALL_DIR.next"
backup_dir="$SNAPTEX_INSTALL_DIR.previous"
trap 'rm -rf "$temp_dir"' EXIT
swapped=false
had_unit=false
had_environment=false

if run_root test -f "$unit_target"; then run_root cp "$unit_target" "$temp_dir/previous.service"; had_unit=true; fi
if run_root test -f "$environment_target"; then run_root cp "$environment_target" "$temp_dir/previous.env"; had_environment=true; fi

rollback() {
    trap - ERR
    if [[ "$swapped" != true ]]; then return; fi
    echo "[SnapTeX] Deployment failed; restoring the previous runtime." >&2
    run_root systemctl stop "$SNAPTEX_SERVICE_NAME.service" || true
    run_root rm -rf "$SNAPTEX_INSTALL_DIR"
    if run_root test -d "$backup_dir"; then run_root mv "$backup_dir" "$SNAPTEX_INSTALL_DIR"; fi
    if [[ "$had_unit" == true ]]; then run_root install -m 0644 "$temp_dir/previous.service" "$unit_target"; else run_root rm -f "$unit_target"; fi
    if [[ "$had_environment" == true ]]; then run_root install -m 0600 "$temp_dir/previous.env" "$environment_target"; else run_root rm -f "$environment_target"; fi
    run_root systemctl daemon-reload || true
    run_root systemctl start "$SNAPTEX_SERVICE_NAME.service" || true
}
trap rollback ERR

sed \
    -e "s|@RUN_USER@|$(escape_sed "$SNAPTEX_RUN_USER")|g" \
    -e "s|@RUN_GROUP@|$(escape_sed "$run_group")|g" \
    -e "s|@INSTALL_DIR@|$(escape_sed "$SNAPTEX_INSTALL_DIR")|g" \
    -e "s|@ENV_FILE@|$(escape_sed "$environment_target")|g" \
    -e "s|@NODE_BIN@|$(escape_sed "$node_bin")|g" \
    -e "s|@PROJECTS_ROOT@|$(escape_sed "$SNAPTEX_PROJECTS_ROOT")|g" \
    "$template_file" > "$unit_file"

if ! run_root systemd-analyze verify "$unit_file" >/dev/null 2>"$verify_log"; then
    cat "$verify_log" >&2
    exit 1
fi

cat > "$environment_file" <<EOF
NODE_ENV=production
HOST="$(systemd_quote "$HOST")"
PORT="$(systemd_quote "$PORT")"
SNAPTEX_PROJECTS_ROOT="$(systemd_quote "$SNAPTEX_PROJECTS_ROOT")"
SNAPTEX_AUTH_USERNAME="$(systemd_quote "$SNAPTEX_AUTH_USERNAME")"
SNAPTEX_AUTH_PASSWORD="$(systemd_quote "$SNAPTEX_AUTH_PASSWORD")"
SNAPTEX_PUBLIC_ORIGIN="$(systemd_quote "$SNAPTEX_PUBLIC_ORIGIN")"
SNAPTEX_PUBLIC_PATH="$(systemd_quote "$SNAPTEX_PUBLIC_PATH")"
EOF

echo "[SnapTeX] Installing runtime files in $SNAPTEX_INSTALL_DIR..."
run_root rm -rf "$next_dir" "$backup_dir"
run_root install -d -o "$SNAPTEX_RUN_USER" -g "$run_group" "$next_dir/apps/web"
run_root cp -a "$repo_root/dist-web" "$next_dir/dist-web"
run_root install -o "$SNAPTEX_RUN_USER" -g "$run_group" -m 0644 \
    "$repo_root/apps/web/server.mjs" "$repo_root/apps/web/web-session.mjs" "$next_dir/apps/web/"
run_root chown -R "$SNAPTEX_RUN_USER:$run_group" "$next_dir"

if run_root test -d "$SNAPTEX_INSTALL_DIR"; then run_root mv "$SNAPTEX_INSTALL_DIR" "$backup_dir"; fi
run_root mv "$next_dir" "$SNAPTEX_INSTALL_DIR"
swapped=true
run_root install -m 0600 "$environment_file" "$environment_target"
run_root install -m 0644 "$unit_file" "$unit_target"
run_root systemctl daemon-reload
run_root systemctl enable --now "$SNAPTEX_SERVICE_NAME.service"
run_root systemctl restart "$SNAPTEX_SERVICE_NAME.service"

health_host="$HOST"
if [[ "$HOST" == *:* ]]; then health_host="[$HOST]"; fi
for _ in {1..20}; do
    if curl --fail --silent "http://$health_host:$PORT/healthz" >/dev/null 2>&1; then
        swapped=false
        trap - ERR
        echo "[SnapTeX] Deployment complete: http://$HOST:$PORT/"
        exit 0
    fi
    sleep 0.5
done
false
