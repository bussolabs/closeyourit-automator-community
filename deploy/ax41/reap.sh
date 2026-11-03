#!/usr/bin/env bash
# Deletes automator VMs whose lease expired (CYAU-302): a crashed daemon or a lost host must not leave
# a running session behind. Only `ca-run-*` instances marked as managed are ever touched.
set -euo pipefail
project=$1
now=$(date +%s)
incus list --project "$project" --format=json \
  | jq -r --argjson now "$now" '.[]
      | select(.name | test("^ca-run-[a-f0-9]{32}$"))
      | select(.config["user.automator.managed"] == "true")
      | select(((.config["user.automator.expires"] // "0") | tonumber? // 0) <= $now)
      | .name' \
  | while read -r name; do
      incus delete --project "$project" "$name" --force
    done
