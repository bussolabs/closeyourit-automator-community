#!/usr/bin/env bash
# Starts the GitHub and Codex device logins of the daemon user in the background (CYAU-302). Each runs in a
# transient user unit, so it keeps polling after this SSH session ends; its output (URL + one-time code) is
# printed here for a person to confirm in a browser. A login already in place is left alone.
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
uid=$(id -u)
export XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus"
logs="$HOME/.local/state/device-login"
mkdir -p "$logs"

command -v codex >/dev/null || { npm install -g @openai/codex >/dev/null && mise reshim; }
# The review trusts ~/.local/bin, never the mise shims: without this link every Claude review fails with
# "Claude OS confinement is unavailable", because Claude is confined through Codex (CYRA-1193).
ln -sfn "$(mise which codex)" "$HOME/.local/bin/codex"

start() {  # <unit> <log> <answers> <command...>
  local unit=$1 log=$2 answers=$3; shift 3
  # A login already waiting with its code keeps that code: restarting it would void what the person confirms.
  if systemctl --user is-active --quiet "$unit" && grep -aqE '[A-Z0-9]{4,5}-[A-Z0-9]{4,5}' "$log"; then return; fi
  systemctl --user stop "$unit" 2>/dev/null || true
  : > "$log"
  # `script` gives the CLI the terminal it insists on; the answers go in one by one and stdin stays open
  # while the CLI polls for the confirmation.
  local run="(for a in $answers; do sleep 3; printf '%s\\n' \"\$a\" | tr -d _; done; sleep 900) | script -qfec \"$*\" /dev/null"
  # Without a terminal, gh skips its interactive menu and prints the code straight away.
  [[ $answers == none ]] && run="$* < /dev/null"
  systemd-run --user --quiet --collect "--unit=$unit" -p RuntimeMaxSec=900 "--setenv=PATH=$PATH" "--setenv=HOME=$HOME" \
    /bin/sh -c "$run > '$log' 2>&1"
}

if gh auth status --hostname github.com >/dev/null 2>&1; then
  # The daemon fetches ticket repositories over https outside any session: git needs gh as its credential helper.
  gh auth setup-git --hostname github.com
  echo 'github: already signed in, git uses it'
else
  start device-login-gh "$logs/gh.log" none gh auth login --hostname github.com --git-protocol https --web --scopes repo
fi
if codex login status >/dev/null 2>&1; then
  echo 'codex: already signed in'
else
  start device-login-codex "$logs/codex.log" "_" codex login --device-auth
fi
sleep 10
for log in "$logs"/*.log; do
  echo "--- $(basename "$log")"
  # Only the lines a person needs: the address and the one-time code.
  grep -aoE 'https://[^ ]+|[A-Z0-9]{4,5}-[A-Z0-9]{4,5}' "$log" | sort -u || true
done
