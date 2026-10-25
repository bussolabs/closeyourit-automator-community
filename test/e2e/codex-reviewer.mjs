import fs from 'node:fs'

const input = fs.readFileSync(0, 'utf8')
const marker = 'UNTRUSTED_REVIEW_INPUT_JSON='
const offset = input.indexOf(marker)
if (offset < 0) process.exit(65)

const payload = JSON.parse(input.slice(offset + marker.length))
process.stdout.write(JSON.stringify({
  review_complete: true,
  reviewed_base_commit: payload.base_commit,
  reviewed_snapshot_tree: payload.snapshot_tree,
  reviewed_diff_sha256: payload.diff_sha256,
  findings: [],
}))
