#!/usr/bin/env bash
# Runs one AX41 step from the ax41-vm workflow, with its short-lived AX41-only SSH certificate (CYAU-302):
#   enroll  — daemon user, Secret Service, bootstrap and `automator oneclick` (tokens on stdin only);
#   refresh — enroll with `oneclick --reset`, so projects added to the machine's scope get cloned and linked;
#   install — VM containment installer as root, then the isolation smoke as the daemon user;
#   status  — read-only: doctor and the daemon's latest journal lines;
#   diag    — boots throwaway VMs with and without the shared disk and prints their logs;
#   login   — starts the GitHub and Codex device logins and prints the codes to confirm;
#   vm-off / vm-on — set the VM containment config aside (sessions fall back to bubblewrap) or restore it.
# shellcheck disable=SC2029
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]]
mode=$1
cd -- "$(dirname -- "$0")"
host=root@65.108.123.43
remote="/opt/closeyourit-automator-vm-bootstrap-$GITHUB_SHA"
ssh_args=(-T -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$RUNNER_TEMP/ax41-known-hosts" -o ConnectTimeout=10)
ssh "${ssh_args[@]}" "$host" "install -d -m 0700 '$remote'"
case "$mode" in
  enroll|refresh)
    [[ -n "${ENROLL_GITHUB_TOKEN:-}" && -n "${ENROLL_CLOSEYOURIT_TOKEN:-}" ]]
    tar -cf - enroll.sh -C ../../bin bootstrap.sh | ssh "${ssh_args[@]}" "$host" "tar -xf - -C '$remote'"
    printf '%s\n%s\n' "$ENROLL_GITHUB_TOKEN" "$ENROLL_CLOSEYOURIT_TOKEN" |
      ssh "${ssh_args[@]}" "$host" "GITHUB_ACTIONS=true ONECLICK_RESET=$([[ $mode == refresh ]] && echo 1 || echo 0) timeout 2400 bash '$remote/enroll.sh'"
    ;;
  install)
    tar -cf - install.sh guest-setup.sh run-with-env reap.sh egress-allowlist smoke.sh | ssh "${ssh_args[@]}" "$host" "tar -xf - -C '$remote'"
    ssh "${ssh_args[@]}" "$host" "GITHUB_ACTIONS=true timeout 1800 bash '$remote/install.sh'"
    # On failure the VM logs (root-only) say why a guest did not boot.
    ssh "${ssh_args[@]}" "$host" "runuser -l automator -c /opt/closeyourit-automator-vm/smoke.sh || { for f in /var/log/incus/user-*_ca-run-*/*.log; do echo \"--- \$f\"; tail -30 \"\$f\"; done; exit 1; }"
    ;;
  diag)
    tar -cf - diag.sh | ssh "${ssh_args[@]}" "$host" "tar -xf - -C '$remote'"
    ssh "${ssh_args[@]}" "$host" "GITHUB_ACTIONS=true timeout 900 bash '$remote/diag.sh'" || true
    ;;
  login)
    tar -cf - device-login.sh | ssh "${ssh_args[@]}" "$host" "tar -xf - -C '$remote' && install -o automator -g automator -m 0755 '$remote/device-login.sh' /home/automator/device-login.sh"
    ssh "${ssh_args[@]}" "$host" "runuser -l automator -c /home/automator/device-login.sh"
    ;;
  status)
    # The newest action log, and the groups the running daemon really holds (a group added after the user's
    # systemd manager started is not in its processes until that manager restarts).
    ssh "${ssh_args[@]}" "$host" 'f=$(ls -t /home/automator/.local/state/closeyourit-automator/logs/*.log 2>/dev/null | head -1); echo "--- $f"; [ -n "$f" ] && tail -25 "$f"; for p in $(pgrep -u automator -f "automator.*daemon"); do echo "daemon $p: $(grep -E "^Groups" /proc/$p/status)"; done; echo "automator ids: $(id automator)"' || true
    # Ticket worktrees: owners other than the daemon user (left by a guest before the id mapping) break `prepare`.
    ssh "${ssh_args[@]}" "$host" 'd=/home/automator/.local/share/closeyourit-automator/worktrees; ls -la "$d" "$d"/* 2>&1 | head -40; echo "foreign-owned: $(find "$d" ! -user automator 2>/dev/null | wc -l)"; find "$d" ! -user automator 2>/dev/null | head -5; for r in closeyourit-rails closeyourit-cli; do p=$(find /home/automator/Lavoro -maxdepth 4 -type d -name "$r" | head -1); echo "== $p"; runuser -u automator -- git -C "$p" worktree list 2>&1 | head -8; runuser -l automator -c "git -C $p remote -v | head -1 | sed -E \"s#//[^@/]*@#//***@#\"; timeout 60 git -C $p fetch origin 2>&1 | tail -3; echo fetch-exit=\$?"; done' || true
    # Optional: read one ticket's clarification state as the daemon does, to see why it reads as unreadable.
    [[ -z "${STATUS_TICKET:-}" || "$STATUS_TICKET" =~ ^[A-Z]{2,6}-[0-9]+$ ]]
    if [[ -n "${STATUS_TICKET:-}" ]]; then
      ssh "${ssh_args[@]}" "$host" "runuser -l automator -c 'export PATH=\$HOME/.local/bin:\$HOME/.local/share/mise/shims:\$PATH; cyi tickets clarifications $STATUS_TICKET -p ${STATUS_TICKET%%-*} --json 2>&1 | head -c 800; echo; echo exit=\${PIPESTATUS[0]}'" || true
    fi
    ssh "${ssh_args[@]}" "$host" 'uid=$(id -u automator); runuser -l automator -c "export XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus PATH=\$HOME/.local/bin:\$HOME/.local/share/mise/shims:\$PATH; automator doctor; journalctl --user -u closeyourit-automator.service -n 40 --no-pager; systemctl --user list-units --all --no-pager \"device-login-*\"; for f in \$HOME/.local/state/device-login/*.log; do echo --- \$f; sed -e \"s/\x1b\\[[0-9;?]*[a-zA-Z]//g\" \$f | head -30; done"' || true
    ;;
  vm-off|vm-on)
    config=/etc/closeyourit-automator/vm-containment.json
    if [[ $mode == vm-off ]]; then from=$config to=$config.off; else from=$config.off to=$config; fi
    ssh "${ssh_args[@]}" "$host" "if [ -f '$from' ]; then mv '$from' '$to'; fi; ls -l /etc/closeyourit-automator/"
    ssh "${ssh_args[@]}" "$host" 'uid=$(id -u automator); runuser -l automator -c "export XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus; systemctl --user restart closeyourit-automator.service; systemctl --user is-active closeyourit-automator.service"'
    ;;
  *) echo "unknown mode: $mode" >&2; exit 2 ;;
esac
ssh "${ssh_args[@]}" "$host" "rm -rf '$remote'"
