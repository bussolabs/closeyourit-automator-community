#!/usr/bin/env bash
# Runs a command of the end-to-end bench (CYAU-204) isolated from the other jobs on the same runner.
#
# Eight runners per box share the `runner` user: same HOME, same user systemd manager,
# same keyring. Here the command gets its own HOME and XDG folders and a private Secret Service;
# at the end none of its processes survives and the folder disappears.
#
# The automator derives the D-Bus bus and systemd from the same XDG_RUNTIME_DIR. The private runtime folder
# therefore contains the private keyring bus and a link to the real runtime `systemd/`: the
# `systemd-run --user --scope` scopes go through the private systemd socket, not through the session bus.
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <command> [arguments...]" >&2
  exit 2
fi
if [[ "$(uname -s)" != Linux ]]; then
  echo "the end-to-end bench runs only on Linux" >&2
  exit 1
fi

uid="$(id -u)"
shared_runtime="/run/user/$uid"
if [[ ! -S "$shared_runtime/systemd/private" ]]; then
  echo "user systemd manager not reachable at $shared_runtime/systemd/private" >&2
  exit 1
fi

root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/automator-e2e.XXXXXX")"
bus_pid=''

# Counts the automator entries in the shared keyring: if the command wrote there by mistake,
# a later job would inherit them.
shared_keyring_items() {
  local total=0 service count
  for service in it.closeyour.automator.host it.closeyour.automator.vault; do
    count="$(env -i PATH=/usr/bin:/bin XDG_RUNTIME_DIR="$shared_runtime" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=$shared_runtime/bus" \
      timeout 5 /usr/bin/secret-tool search --all service "$service" 2>/dev/null | grep -c '^\[' || true)"
    total=$((total + count))
  done
  echo "$total"
}

# Bench processes: those inheriting the marker and those working inside the folder
# (the runtimes launched by the automator have a cleaned environment, but their cwd stays here).
bench_pids() {
  local proc pid
  for proc in /proc/[0-9]*; do
    pid="${proc#/proc/}"
    # Only the user's processes: we did not launch the others and they are not readable.
    [[ "$pid" == "$$" || ! -O "$proc" ]] && continue
    # The braces also catch the redirection error: a process can end between the two steps.
    if { tr '\0' '\n' <"$proc/environ"; } 2>/dev/null | grep -qxF "AUTOMATOR_E2E_ROOT=$root" \
      || [[ "$(readlink "$proc/cwd" 2>/dev/null)" == "$root"* ]]; then
      echo "$pid"
    fi
  done
}

cleanup() {
  local status=$? pids
  trap - EXIT
  [[ -z "$bus_pid" ]] || kill "$bus_pid" 2>/dev/null || true
  pids="$(bench_pids)"
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    sleep 2
    pids="$(bench_pids)"
    # shellcheck disable=SC2086
    [[ -z "$pids" ]] || kill -KILL $pids 2>/dev/null || true
    sleep 1
  fi
  pids="$(bench_pids)"
  if [[ -n "$pids" ]]; then
    echo "::error::bench processes survived the cleanup: $(echo "$pids" | tr '\n' ' ')" >&2
    status=1
  fi
  /bin/rm -rf -- "$root"
  if [[ "$(shared_keyring_items)" != "$keyring_before" ]]; then
    echo "::error::the bench left automator entries in the shared keyring" >&2
    status=1
  fi
  exit "$status"
}

keyring_before="$(shared_keyring_items)"
trap cleanup EXIT

install -d -m 700 "$root/home" "$root/config" "$root/data" "$root/state" "$root/cache" "$root/runtime"
ln -s "$shared_runtime/systemd" "$root/runtime/systemd"

export AUTOMATOR_E2E_ROOT="$root"
export HOME="$root/home"
export XDG_CONFIG_HOME="$root/config"
export XDG_DATA_HOME="$root/data"
export XDG_STATE_HOME="$root/state"
export XDG_CACHE_HOME="$root/cache"
export XDG_RUNTIME_DIR="$root/runtime"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$root/runtime/bus"

bus_pid="$(/usr/bin/dbus-daemon --session --fork --print-pid=1 --address="$DBUS_SESSION_BUS_ADDRESS")"
if [[ ! "$bus_pid" =~ ^[0-9]+$ ]]; then
  echo "starting the private D-Bus session failed" >&2
  exit 1
fi

# `--unlock` creates the login collection with an empty password: it applies only to this ephemeral keyring.
printf '\n' | /usr/bin/gnome-keyring-daemon --unlock --components=secrets >/dev/null

ready=false
for _attempt in $(seq 1 20); do
  if timeout 1 /usr/bin/secret-tool search --all service it.closeyour.automator.e2e-probe >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.25
done
if [[ "$ready" != true ]]; then
  echo "private Secret Service not reachable" >&2
  exit 1
fi

"$@"
