#!/usr/bin/env bash
# Prepares the AX41 as an automator machine (CYAU-302): daemon user, lingering user manager, an unlocked
# Secret Service, then bootstrap + `automator oneclick`. Idempotent; reruns resume where oneclick stopped.
# Two lines arrive on stdin, never in argv: a GitHub token able to read the private release, then the
# service account token. Run as root, only from the ax41-vm workflow.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "$(id -u)" == 0 ]]
cd -- "$(dirname -- "$0")"
user=automator
IFS= read -r github_token
IFS= read -r closeyourit_token
[[ -n "$github_token" && "$closeyourit_token" == cyi_u_* ]] || { echo 'enroll: missing tokens on stdin' >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y git curl jq unzip build-essential bubblewrap socat \
  dbus-user-session gnome-keyring libsecret-tools
hostnamectl set-hostname server-minion-2
id "$user" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$user"
# Ubuntu 24.04 denies user namespaces to unprivileged processes, and bubblewrap ships no profile: without this
# one the write-confinement probe fails and the host never attests. Only bwrap gets userns; the global
# restriction stays on (same profile as server-minion-1 and the CI runners).
cat > /etc/apparmor.d/bwrap <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  include if exists <local/bwrap>
}
PROFILE
apparmor_parser -r /etc/apparmor.d/bwrap
loginctl enable-linger "$user"
uid=$(id -u "$user") home=$(getent passwd "$user" | cut -d: -f6)
for _ in $(seq 1 30); do [[ -S "/run/user/$uid/bus" ]] && break; sleep 1; done

# A headless host has no login session to unlock the keyring: a user unit keeps the `login` collection
# open from boot. Empty password: the same user that reads the keyring could read its password file.
# Every level must belong to the user: `install -d` alone leaves the parents to root, and then mise and
# systemd cannot write their own config (`failed create_dir_all: ~/.config/mise`).
for dir in "$home/.config" "$home/.config/systemd" "$home/.config/systemd/user"; do
  install -d -o "$user" -g "$user" "$dir"
  chown "$user:$user" "$dir"
done
cat > "$home/.config/systemd/user/automator-keyring.service" <<'UNIT'
[Unit]
Description=Unlocked Secret Service for the headless automator
[Service]
ExecStart=/bin/sh -c 'printf "\n" | exec /usr/bin/gnome-keyring-daemon --unlock --foreground --components=secrets'
Restart=on-failure
[Install]
WantedBy=default.target
UNIT
chown "$user:" "$home/.config/systemd/user/automator-keyring.service"
install -o "$user" -g "$user" -m 0755 bootstrap.sh "$home/bootstrap.sh"

as_user() {
  runuser -l "$user" -c "export XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus; $1"
}
as_user 'systemctl --user daemon-reload && systemctl --user enable --now automator-keyring.service'
for _ in $(seq 1 20); do
  as_user 'timeout 2 secret-tool search --all service it.closeyour.automator.probe >/dev/null 2>&1' && break
  sleep 1
done

# The bootstrap refuses to reinstall over itself; once the launcher exists, `automator update` owns upgrades.
if [[ ! -x "$home/.local/bin/automator" ]]; then
  printf '%s\n' "$github_token" | as_user 'IFS= read -r GH_TOKEN; export GH_TOKEN; sh ~/bootstrap.sh'
fi
# Install the managed service first: it registers the host, and only a registered, certified host receives the
# organization's Claude credential that oneclick's auth stage then accepts.
# shellcheck disable=SC2016 # $HOME and $PATH belong to the daemon user's shell
# The active release comes from the private GitHub release: the workflow token reads it once here. Hourly
# self-updates need the host's own durable `gh` login.
printf '%s\n' "$github_token" | as_user \
  'IFS= read -r GH_TOKEN; export GH_TOKEN; export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"; automator update'
# shellcheck disable=SC2016 # $HOME and $PATH belong to the daemon user's shell
printf '%s\n' "$closeyourit_token" | as_user \
  'IFS= read -r CLOSEYOURIT_TOKEN; export CLOSEYOURIT_TOKEN; export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"; automator install --managed --skills-enabled --secrets-project CYCL && automator status'
# The daemon runs `cyi` without a token (e.g. to read a ticket's clarification state), so cyi needs its own
# stored login: the service account token, written owner-only, only when none is stored yet.
# shellcheck disable=SC2016 # $HOME and the token belong to the daemon user's shell
printf '%s\n' "$closeyourit_token" | as_user \
  'IFS= read -r T; umask 077; d="$HOME/.config/closeyourit"; f="$d/config.json"; mkdir -p "$d"; if [ -f "$f" ] && jq -e ".token // empty" "$f" >/dev/null; then echo "cyi: login already stored"; else T="$T" jq -n "{apiUrl: \"https://app.closeyour.it\", token: env.T}" > "$f.tmp" && mv "$f.tmp" "$f" && chmod 600 "$f" && echo "cyi: service account login stored"; fi'
# oneclick exits 3 when a stage needs a person (device login): that is reported, not a failure.
# ONECLICK_RESET=1 reruns every stage, so a project added to the machine's scope is cloned and linked.
reset_flag=""
[[ "${ONECLICK_RESET:-0}" == 1 ]] && reset_flag=" --reset"
set +e
# shellcheck disable=SC2016 # $HOME and $PATH belong to the daemon user's shell
printf '%s\n' "$closeyourit_token" | as_user \
  'IFS= read -r CLOSEYOURIT_TOKEN; export CLOSEYOURIT_TOKEN; export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"; automator oneclick'"${reset_flag}"
status=$?
set -e
[[ $status == 0 || $status == 3 ]] || exit "$status"
# oneclick's install stage runs a bare `install --managed`, which turns skill-mode off and resets the secrets
# project: the service is installed again with this host's options, last, and restarted so the running daemon
# takes them (install does not restart a running service). The Tester is on for this host (CYAU-329).
# shellcheck disable=SC2016 # $HOME and $PATH belong to the daemon user's shell
printf '%s\n' "$closeyourit_token" | as_user \
  'IFS= read -r CLOSEYOURIT_TOKEN; export CLOSEYOURIT_TOKEN; export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"; AUTOMATOR_TESTER=1 automator install --managed --skills-enabled --secrets-project CYCL >/dev/null && systemctl --user restart closeyourit-automator.service && automator status'
echo "enroll: oneclick exit $status (3 = waiting for a person)"
