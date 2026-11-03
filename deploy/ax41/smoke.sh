#!/usr/bin/env bash
# Real isolation proof after install (CYAU-302). Runs on the AX41 as the daemon user, through its restricted
# Incus project, exactly the way a session VM is built. Every check must hold or the install is not done.
set -euo pipefail
config=/etc/closeyourit-automator/vm-containment.json
image=$(jq -r .image "$config") pool=$(jq -r .pool "$config")
network=$(jq -r '.networks[0]' "$config") proxy=$(jq -r '.proxies[0]' "$config")
gateway=${proxy#http://}; gateway=${gateway%:*}
name="ca-run-$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
shared=$(mktemp -d "$HOME/vm-smoke.XXXXXX")
# mktemp makes it 0700, and virtiofsd cannot open a share like that (`OpenNewRoot … Permission denied`); a
# git worktree is 0755, like this.
chmod 0755 "$shared"
cleanup() { timeout 60 incus delete "$name" --force >/dev/null 2>&1 || echo "smoke: cleanup of $name timed out" >&2; rm -rf "$shared"; }
trap cleanup EXIT

# A proof VM left behind by an interrupted run keeps slot 0 busy and hangs the next proof. Only VMs past their
# lease go: a live session VM is never touched.
now=$(date +%s)
for stale in $(incus list --format=json | jq -r --argjson now "$now" \
    '.[] | select(.name | startswith("ca-run-")) | select((.config["user.automator.expires"] // "0" | tonumber) < $now) | .name'); do
  timeout 60 incus delete "$stale" --force >/dev/null 2>&1 || echo "smoke: could not remove $stale" >&2
done
echo "smoke: step creating $name"
incus init "$image" "$name" --vm --no-profiles "--storage=$pool" \
  -c limits.cpu=2 -c limits.memory=4GiB -c boot.autostart=false \
  -c user.automator.managed=true -c user.automator.slot=0 -c "user.automator.expires=$(( $(date +%s) + 900 ))" \
  -c "raw.idmap=both $(id -u) $(id -u)"
incus config device add "$name" eth0 nic nictype=bridged "parent=$network"
incus config device add "$name" workspace disk "source=$shared" "path=$shared"
# The toolchain paths a session gets, read-only at the same location, exactly as the daemon mounts them.
ro_index=0
while IFS= read -r dir; do
  incus config device add "$name" "ro$ro_index" disk "source=$dir" "path=$dir" readonly=true >/dev/null
  ro_index=$((ro_index + 1))
done < <(jq -r '.read_only_paths[]' /etc/closeyourit-automator/vm-containment.json)
if ! timeout 180 incus start "$name"; then
  incus info --show-log "$name" | tail -40
  exit 1
fi
ready=no
for _ in $(seq 1 60); do timeout 5 incus exec "$name" -- /bin/true >/dev/null 2>&1 && { ready=yes; break; }; sleep 2; done
[[ $ready == yes ]] || { echo "smoke: FAIL the guest agent never answered" >&2; exit 1; }
echo "smoke: step guest agent ready"

guest() { timeout 60 incus exec "$name" "--user=$(id -u)" "--group=$(id -g)" "--cwd=$shared" -- "$@"; }
check() { echo "smoke: $1"; }

guest ip -4 -brief address show
guest curl -fsS -o /dev/null --max-time 30 -x "$proxy" https://api.github.com/zen
check 'allowlisted host reachable through the proxy'
if guest curl -fsS -o /dev/null --max-time 15 -x "$proxy" https://example.com; then
  echo 'smoke: FAIL a host outside the allowlist was reachable' >&2; exit 1
fi
check 'host outside the allowlist refused'
if guest curl -fsS -o /dev/null --max-time 10 --noproxy '*' https://1.1.1.1; then
  echo 'smoke: FAIL direct internet access without the proxy' >&2; exit 1
fi
check 'no direct internet access'
if guest timeout 10 bash -c "exec 3<>/dev/tcp/$gateway/22" 2>/dev/null; then
  echo 'smoke: FAIL the host SSH port is reachable from the guest' >&2; exit 1
fi
check 'host services other than the proxy unreachable'
guest touch "$shared/written-in-guest"
[[ "$(stat -c %u "$shared/written-in-guest")" == "$(id -u)" ]]
check 'shared workspace writable with the daemon user identity'
guest test -x /opt/automator/run-with-env
guest pg_isready -q
check 'guest image has the launcher and a running Postgres'

# The agent CLIs must start from the read-only share through the launcher, as a session starts them.
guest bash -c "printf 'PATH=/usr/bin:/bin\\0' > /tmp/smoke-env && /opt/automator/run-with-env /tmp/smoke-env '$HOME/.local/bin/claude' --version"
check 'claude starts inside the guest through the launcher'
# Sessions inherit the daemon's PATH (mise shims): cyi must resolve there too, or the agent cannot read the ticket.
daemon_pid=$(pgrep -u "$(id -u)" -x -f '.*closeyourit-automator.* daemon.*' | head -1 || true)
session_path="$HOME/.local/share/mise/shims:$HOME/.local/bin:/usr/bin:/bin"
if [[ -n "$daemon_pid" ]]; then
  session_path=$(tr '\0' '\n' < "/proc/$daemon_pid/environ" | sed -n 's/^PATH=//p')
fi
echo "smoke: session PATH=$session_path"
echo "smoke: host cyi=$(PATH=$session_path command -v cyi || echo missing) -> $(readlink -f "$(PATH=$session_path command -v cyi 2>/dev/null)" 2>/dev/null)"
guest bash -c "printf 'PATH=%s\\0HOME=%s\\0' '$session_path' '$HOME' > /tmp/smoke-env && /opt/automator/run-with-env /tmp/smoke-env cyi --version"
check 'cyi starts inside the guest with the session PATH'
echo 'smoke: all isolation checks passed'
