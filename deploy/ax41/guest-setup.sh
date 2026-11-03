#!/usr/bin/env bash
# Runs once inside the image build VM (CYAU-302). Arguments: <uid> <gid> of the host automator user, so the
# shared worktree is writable inside the guest under the same identity.
set -euo pipefail
uid=$1 gid=$2
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  git curl bubblewrap socat ca-certificates python3 build-essential pkg-config \
  libpq-dev libyaml-dev libssl-dev zlib1g-dev libffi-dev libreadline-dev \
  postgresql postgresql-contrib
apt-get clean

# The cloud image ships an `ubuntu` user on uid/gid 1000, the same IDs the host automator usually has.
existing=$(getent passwd "$uid" | cut -d: -f1 || true)
[[ -n "$existing" && "$existing" != automator ]] && userdel --remove "$existing"
existing=$(getent group "$gid" | cut -d: -f1 || true)
[[ -n "$existing" && "$existing" != automator ]] && groupdel "$existing"
groupadd --gid "$gid" automator
useradd --uid "$uid" --gid "$gid" --create-home --shell /bin/bash automator

# Tests reach Postgres locally over the socket as the session user.
systemctl enable postgresql
runuser -u postgres -- psql -c "CREATE ROLE automator LOGIN SUPERUSER"

install -d -m 0755 /opt/automator
install -m 0755 /root/run-with-env /opt/automator/run-with-env
install -m 0755 /root/mise /usr/local/bin/mise
# The env file lives on a tmpfs owned by the session user.
echo 'tmpfs /run/automator tmpfs mode=0700,uid='"$uid"',gid='"$gid"',size=4m 0 0' >> /etc/fstab
