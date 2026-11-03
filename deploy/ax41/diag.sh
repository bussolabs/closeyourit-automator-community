#!/usr/bin/env bash
# CYAU-302 — read-only-ish diagnosis of a session VM that does not boot. Boots two throwaway VMs in the daemon
# user's project, one without and one with the shared worktree disk, each under a time limit, then prints the
# Incus, QEMU and virtiofsd logs and removes them even when they hang. Run as root, only from the ax41-vm workflow.
set -uo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "$(id -u)" == 0 ]] || exit 1
config=/etc/closeyourit-automator/vm-containment.json
user=automator
uid=$(id -u "$user") home=$(getent passwd "$user" | cut -d: -f6)
project="user-$uid"
image=$(jq -r '.image' "$config") pool=$(jq -r '.pool' "$config") network=$(jq -r '.networks[0]' "$config")
command -v virtiofsd /usr/libexec/virtiofsd /usr/lib/qemu/virtiofsd 2>/dev/null | sed 's/^/virtiofsd: /'
incus version

as_user() { runuser -l "$user" -c "$1"; }

# Hypothesis under test: virtiofsd sees the share through the VM idmap, where host uid 1000 does not exist (the
# guest sees 65534). Let Incus map exactly the daemon user's uid/gid onto itself.
changed=no
for f in /etc/subuid /etc/subgid; do
  grep -qx "root:$uid:1" "$f" || { echo "root:$uid:1" >> "$f"; changed=yes; }
done
[[ $changed == yes ]] && { systemctl restart incus; sleep 5; }
incus project set "$project" "restricted.idmap.uid=$uid" "restricted.idmap.gid=$(id -g "$user")"

boot() {  # <label> <with-disk: yes|no>
  local name="ca-diag-$1" shared="$home/ca-diag-share"
  echo "=== $1 (shared disk: $2)"
  as_user "incus delete $name --force" >/dev/null 2>&1
  as_user "incus init $image $name --vm --no-profiles --storage=$pool -c limits.cpu=2 -c limits.memory=2GiB"
  as_user "incus config device add $name eth0 nic nictype=bridged parent=$network" >/dev/null
  if [[ $2 == yes ]]; then
    install -d -o "$user" -g "$user" "$shared"
    as_user "incus config device add $name workspace disk source=$shared path=$shared" >/dev/null
    as_user "incus config set $name raw.idmap='both $uid $uid'"
  fi
  if timeout 120 runuser -l "$user" -c "incus start $name"; then echo "start: ok"; else echo "start: FAILED or timed out ($?)"; fi
  for _ in $(seq 1 30); do as_user "incus exec $name -- /bin/true" >/dev/null 2>&1 && { echo 'agent: ready'; break; }; sleep 2; done
  as_user "incus list $name --format=csv -c ns"
  if [[ $2 == yes ]]; then
    namei -l "$shared"
    pgrep -a -f "virtiofsd.*${project}_$name" | cut -c1-300
    as_user "timeout 30 incus exec $name --user=$uid --group=$(id -g "$user") -- sh -c 'mount | grep $shared; id; ls -ldn $shared; touch $shared/written && echo write: ok'" || echo 'write: FAILED'
    ls -ln "$shared"
    findmnt -o TARGET,SOURCE,OPTIONS -T "/var/lib/incus/devices/${project}_$name" 2>/dev/null | tail -3
    incus config show "$name" --project "$project" | grep -iE "idmap|shift|raw" || echo "no idmap keys"
  fi
  for f in /var/log/incus/"${project}_$name"/*; do echo "--- $f"; tail -25 "$f"; done
  pkill -f "qemu-system.*${project}_$name" || true
  pkill -f "virtiofsd.*${project}_$name" || true
  timeout 60 runuser -l "$user" -c "incus delete $name --force" >/dev/null 2>&1 || echo "delete: timed out"
  rm -rf "$shared"
}

boot plain no
boot shared yes
echo '=== incus daemon'
journalctl -u incus --since '-15 min' --no-pager | tail -40
