#!/usr/bin/env bash
# CYAU-302 — prepares the AX41 so the automator runs every agent session in a disposable Incus VM.
# Idempotent. Runs only from GitHub Actions, as root, after the host is enrolled as an automator machine
# (the daemon user must already exist). Never touches the Coworkers pilot (`cw-*` pool, networks, VMs).
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true ]] || { echo 'Run this installer through GitHub Actions.' >&2; exit 1; }
[[ "$(id -u)" == 0 && "$(uname -m)" == x86_64 && -c /dev/kvm ]]
cd -- "$(dirname -- "$0")"

user=${AUTOMATOR_USER:-automator}
slots=${AUTOMATOR_VM_SLOTS:-3}
cpu=4 memory_gib=8 disk_gib=40 lease_seconds=5400 proxy_port=3128
uid=$(id -u "$user") gid=$(id -g "$user") home=$(getent passwd "$user" | cut -d: -f6)
project="user-$uid"

exec 9>/run/lock/closeyourit-automator-vm-install.lock
flock -n 9
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y incus qemu-system-x86 virtiofsd tinyproxy python3 jq
# Without virtiofsd Incus falls back to a 9p proxy that cannot share the worktree (`share path does not exist`).
systemctl restart incus

# --- storage and one isolated bridge per slot ---------------------------------------------------------------
if ! incus storage show ca-pool >/dev/null 2>&1; then incus storage create ca-pool dir; fi
networks=() proxies=()
for slot in $(seq 0 $((slots - 1))); do
  network="ca-slot$slot" gateway="10.77.$slot.1"
  if ! incus network acl show "$network" >/dev/null 2>&1; then incus network acl create "$network"; fi
  # The only way out of a guest is the egress proxy on its own gateway.
  jq -n --arg gw "$gateway" --arg port "$proxy_port" '{
      description: "Automator VM: egress proxy only",
      ingress: [],
      egress: [{action: "allow", state: "enabled", destination: $gw, protocol: "tcp", destination_port: $port}]}' \
    | incus network acl edit "$network"
  if ! incus network show "$network" >/dev/null 2>&1; then
    # No NAT, no routing: nothing leaves the bridge except through a host service.
    incus network create "$network" "ipv4.address=$gateway/24" ipv4.nat=false ipv4.routing=false ipv6.address=none \
      "security.acls=$network" security.acls.default.ingress.action=reject security.acls.default.egress.action=reject
  fi
  networks+=("$network") proxies+=("http://$gateway:$proxy_port")
done
if ! incus network show ca-build >/dev/null 2>&1; then
  incus network create ca-build ipv4.address=10.77.99.1/24 ipv4.nat=true ipv6.address=none
fi

# --- egress proxy: CONNECT only to the allowlisted hostnames ------------------------------------------------
install -m 0644 egress-allowlist /etc/tinyproxy/automator-allowlist
cat > /etc/tinyproxy/tinyproxy.conf <<CONF
User tinyproxy
Group tinyproxy
Port $proxy_port
Timeout 600
LogLevel Notice
MaxClients 200
Allow 10.77.0.0/16
DisableViaHeader Yes
ConnectPort 443
Filter "/etc/tinyproxy/automator-allowlist"
FilterExtended Yes
FilterDefaultDeny Yes
CONF
systemctl enable tinyproxy
systemctl restart tinyproxy

# --- guest image, rebuilt only when its inputs change -------------------------------------------------------
# The mise shims sessions call (cyi, node, ruby) are links to the host's mise binary: the guest needs the same one.
mise_bin=/usr/local/bin/mise
revision=$( (sha256sum guest-setup.sh run-with-env "$mise_bin"; echo "$uid:$gid") | sha256sum | cut -c1-12)
alias="ca-guest-$revision" build="ca-image-$revision"
cleanup() {
  if [[ "$(incus config get "$build" user.automator.build 2>/dev/null || true)" == "$revision" ]]; then
    incus delete "$build" --force
  fi
}
trap cleanup EXIT
if ! incus image info "$alias" >/dev/null 2>&1; then
  cleanup
  incus launch images:ubuntu/24.04 "$build" --vm --no-profiles --storage=ca-pool --network=ca-build \
    -c limits.cpu=2 -c limits.memory=4GiB -c boot.autostart=false -c "user.automator.build=$revision"
  for _ in $(seq 1 90); do
    if timeout 5 incus exec "$build" -- /bin/true >/dev/null 2>&1; then break; fi
    sleep 1
  done
  incus file push run-with-env "$build/root/run-with-env"
  incus file push guest-setup.sh "$build/root/guest-setup.sh"
  incus file push "$mise_bin" "$build/root/mise"
  timeout 1200 incus exec "$build" -- /bin/bash /root/guest-setup.sh "$uid" "$gid"
  incus stop "$build" --timeout=60
  incus publish "$build" --alias "$alias"
fi

# --- the daemon user drives Incus through its restricted project, never as incus-admin -----------------------
usermod -aG incus "$user"
systemctl enable --now incus-user.socket
# A group added while the user's systemd manager runs never reaches the daemon it starts: restart that manager
# (and with it the daemon) when its processes do not hold the incus group yet.
incus_gid=$(getent group incus | cut -d: -f3)
manager=$(systemctl show -p MainPID --value "user@$uid.service")
if [[ "$manager" =~ ^[1-9][0-9]*$ ]] && ! grep -Eq "^Groups:.*\b$incus_gid\b" "/proc/$manager/status"; then
  systemctl restart "user@$uid.service"
fi
runuser -l "$user" -c 'incus project list' >/dev/null  # incus-user creates the project on first use
# incus-user gives the project a default profile wired to incusbr0, which the restriction below forbids. Session
# VMs launch with --no-profiles, so that NIC is never used: drop it, or the restriction is refused.
if incus profile device show default --project "$project" | grep -q '^eth0:'; then
  incus profile device remove default eth0 --project "$project"
fi
# Session VMs map the daemon user's uid/gid 1:1 (raw.idmap), so the worktree shared through virtiofsd keeps its
# owner. Incus allows that only for ids delegated to root and to the restricted project.
for f in /etc/subuid /etc/subgid; do
  grep -qx "root:$uid:1" "$f" || { echo "root:$uid:1" >> "$f"; incus_restart=yes; }
done
[[ ${incus_restart:-no} == yes ]] && systemctl restart incus
incus project set "$project" \
  "restricted.idmap.uid=$uid" "restricted.idmap.gid=$gid" \
  restricted.devices.disk=allow "restricted.devices.disk.paths=$home" restricted.devices.nic=allow \
  "restricted.networks.access=$(IFS=,; echo "${networks[*]}")" \
  restricted.virtual-machines.lowlevel=block limits.containers=0 "limits.virtual-machines=$slots"
if ! incus image info "$alias" --project "$project" >/dev/null 2>&1; then
  # `image copy` between projects needs the server listening on the network; export + import stays local.
  export_dir=$(mktemp -d)
  incus image export "$alias" "$export_dir/image"
  incus image import "$export_dir"/image* --project "$project" --alias "$alias"
  rm -rf "$export_dir"
fi

# --- read-only paths the sessions need at the same location ---------------------------------------------------
read_only=()
for dir in .local/bin .local/share/claude .local/share/mise .config/mise .local/lib/closeyourit-automator \
           .config/closeyourit-automator .local/share/closeyourit-automator/skills .codex; do
  [[ -d "$home/$dir" ]] && read_only+=("$home/$dir")
done

install -d -m 0755 /etc/closeyourit-automator
jq -n --arg image "$alias" --argjson cpu "$cpu" --argjson mem "$memory_gib" --argjson disk "$disk_gib" \
  --argjson lease "$lease_seconds" --argjson uid "$uid" --argjson gid "$gid" \
  --argjson networks "$(printf '%s\n' "${networks[@]}" | jq -R . | jq -s .)" \
  --argjson proxies "$(printf '%s\n' "${proxies[@]}" | jq -R . | jq -s .)" \
  --argjson ro "$(printf '%s\n' "${read_only[@]}" | jq -R . | jq -s .)" \
  '{incus: "/usr/bin/incus", image: $image, pool: "ca-pool", networks: $networks, proxies: $proxies,
    cpu: $cpu, memory_gib: $mem, disk_gib: $disk, lease_seconds: $lease, uid: $uid, gid: $gid,
    launcher: "/opt/automator/run-with-env", env_file: "/run/automator/env", read_only_paths: $ro}' \
  > /etc/closeyourit-automator/vm-containment.json.new
chmod 0644 /etc/closeyourit-automator/vm-containment.json.new
mv /etc/closeyourit-automator/vm-containment.json.new /etc/closeyourit-automator/vm-containment.json

# --- reaper for leases a crashed daemon left behind -----------------------------------------------------------
install -d -m 0755 /opt/closeyourit-automator-vm
install -m 0755 reap.sh /opt/closeyourit-automator-vm/reap.sh
install -m 0755 smoke.sh /opt/closeyourit-automator-vm/smoke.sh
cat > /etc/systemd/system/closeyourit-automator-vm-reaper.service <<UNIT
[Unit]
Description=Remove expired automator session VMs
After=incus.service
[Service]
Type=oneshot
ExecStart=/opt/closeyourit-automator-vm/reap.sh $project
TimeoutStartSec=300
UNIT
cat > /etc/systemd/system/closeyourit-automator-vm-reaper.timer <<'UNIT'
[Unit]
Description=Remove expired automator session VMs every minute
[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=5s
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now closeyourit-automator-vm-reaper.timer
echo "vm containment installed: $slots slots, image $alias, project $project"
