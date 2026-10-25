#!/usr/bin/env bash
# Runs the real credential store round-trip without using the runner's persistent keyring.
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then
  echo "real Secret Service not applicable outside Linux"
  exit 0
fi

for executable in /usr/bin/dbus-daemon /usr/bin/gnome-keyring-daemon /usr/bin/secret-tool; do
  if [[ ! -x "$executable" ]]; then
    echo "missing Secret Service prerequisite: $executable" >&2
    exit 1
  fi
done

temporary_parent="${RUNNER_TEMP:-/tmp}"
keyring_root="$(mktemp -d "$temporary_parent/automator-keyring.XXXXXX")"
bus_pid=''
cleanup() {
  status=$?
  trap - EXIT
  [[ -z "$bus_pid" ]] || kill "$bus_pid" 2>/dev/null || true
  /bin/rm -r -- "$keyring_root"
  exit "$status"
}
trap cleanup EXIT

install -d -m 700 "$keyring_root/runtime" "$keyring_root/data"
private_runtime="$keyring_root/runtime"
private_data="$keyring_root/data"

mapfile -t bus_info < <(
  env XDG_RUNTIME_DIR="$private_runtime" XDG_DATA_HOME="$private_data" \
    /usr/bin/dbus-daemon --session --fork --print-address=1 --print-pid=1
)
if [[ "${bus_info[0]:-}" != unix:* || ! "${bus_info[1]:-}" =~ ^[0-9]+$ ]]; then
  echo "starting the temporary D-Bus session failed" >&2
  exit 1
fi
private_bus="${bus_info[0]}"
bus_pid="${bus_info[1]}"

# `--unlock` starts the daemon and creates the login collection when it does not exist. Starting a foreground
# daemon first would make the API reachable, but would leave the collection missing: search green,
# store failed with "collection/login does not exist".
printf '\n' | env DBUS_SESSION_BUS_ADDRESS="$private_bus" XDG_RUNTIME_DIR="$private_runtime" \
  XDG_DATA_HOME="$private_data" /usr/bin/gnome-keyring-daemon --unlock --components=secrets >/dev/null

service_ready=false
for _attempt in $(seq 1 20); do
  if env DBUS_SESSION_BUS_ADDRESS="$private_bus" XDG_RUNTIME_DIR="$private_runtime" XDG_DATA_HOME="$private_data" \
      timeout 1 /usr/bin/secret-tool search --all service it.closeyour.automator.ci-probe >/dev/null 2>&1; then
    service_ready=true
    break
  fi
  sleep 0.25
done
if [[ "$service_ready" != true ]]; then
  echo "temporary Secret Service not reachable" >&2
  exit 1
fi

# Empty password only for this ephemeral keyring. The test worker uses the private address,
# while the other tests keep the runner's systemd bus. All processes and files are
# destroyed at the end of the script; no later job inherits an unlocked credential store.
export AUTOMATOR_REQUIRE_SECRET_SERVICE_TEST=1
export AUTOMATOR_TEST_SECRET_BUS_ADDRESS="$private_bus"
export AUTOMATOR_TEST_SECRET_RUNTIME_DIR="$private_runtime"
export AUTOMATOR_TEST_SECRET_DATA_HOME="$private_data"
pnpm test
