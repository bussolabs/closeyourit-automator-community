// Local error codes — C{STATUS}-{DOMAIN}-{SEQ} (closeyourit-cli idiom).
// STATUS = HTTP/convention (124 = timeout, 127 = command not found), DOMAIN = domain, SEQ = 3 digits.
export const ErrorCodes = {
  Playbook: {
    notFound: 'C404-PLAYBOOK-001',
    invalid: 'C422-PLAYBOOK-001',
    parse: 'C422-PLAYBOOK-002',
  },
  Schedule: {
    invalid: 'C400-SCHEDULE-001',
  },
  Action: {
    notFound: 'C404-ACTION-001',
  },
  Exec: {
    timeout: 'C124-EXEC-001',
    notFound: 'C127-EXEC-002',
    failed: 'C001-EXEC-003',
    unsafeRuntime: 'C400-EXEC-004',
    // The action requires strong containment but the verifiable kernel backend is not available: never silently
    // degrade to the PGID alone, which does not reach descendants that escaped with setsid/setpgid.
    containmentUnavailable: 'C412-EXEC-005',
    // After TERM→KILL the backend did not prove the container empty within the first deadline: the executor stays
    // fail-closed and retries without approving the run; the outcome is emitted only once the cleanup is proven.
    containmentUnverified: 'C500-EXEC-006',
  },
  Lock: {
    held: 'C000-LOCK-001',
  },
  State: {
    // Reserved. Corruption is handled best-effort WITHOUT throwing (readState marks `corrupt` →
    // quarantineCorruptState preserves the file): no path emits this code today.
    corrupted: 'C000-STATE-001',
    // run-id not safe as a file name (empty, `.`/`..`, separators, `__proto__`/`prototype`/`constructor`).
    invalidRunId: 'C400-STATE-002',
    // `checkpoint` invoked without knowing WHERE the work is: neither --worktree nor --project/--ticket.
    noWorktree: 'C400-STATE-003',
    // `transition` invoked with a state not recognised by the state machine (CYAU-16).
    invalidPhase: 'C400-STATE-004',
    // State transition not allowed from the current phase (CYAU-16): NOT persisted. Legitimate outcome (like
    // Lease.held), dedicated exit 3 so a shell gate does not continue with an illegal transition.
    illegalTransition: 'C409-STATE-005',
  },
  Service: {
    unsupportedOs: 'C000-SVC-001',
    installFailed: 'C000-SVC-002',
  },
  Dep: {
    missingRequired: 'C000-DEP-001',
    installFailed: 'C000-DEP-002',
    sudoRequired: 'C000-DEP-003',
  },
  Sync: {
    notConfigured: 'C400-SYNC-001',
    fetchFailed: 'C502-SYNC-002',
    hostNotConfigured: 'C400-SYNC-003',
  },
  Host: {
    // Agent Host registration requested but the bootstrap orgToken is not configured.
    notConfigured: 'C400-HOST-001',
    // POST /api/v1/hosts failed: CloseYourIt unreachable or contract not honoured.
    registerFailed: 'C502-HOST-002',
  },
  Lease: {
    // Lease requested but the host is not registered: without host_id there is no identity to bind to the lease.
    notConfigured: 'C400-LEASE-001',
    // Invalid lease parameters (empty ticket/host_id/run_id/agent, TTL not a positive integer, --agent
    // missing on acquisition).
    invalidRequest: 'C400-LEASE-002',
    // Cannot reach CloseYourIt to acquire/release the lease (network/HTTP): undetermined outcome.
    requestFailed: 'C502-LEASE-003',
    // Lease already held by ANOTHER host: NOT acquired → do not proceed. Legitimate outcome of Scenario 1
    // (mutual exclusion), reported with a dedicated exit code (3) so a shell gate is safe by default.
    held: 'C409-LEASE-004',
    // The lease of an already started run can no longer be attested (held/expired/error or renewal timeout): the
    // runtime is cancelled and no later phase can start with uncertain ownership.
    lost: 'C409-LEASE-005',
  },
  Guardrails: {
    // Claude action in bypassPermissions but guardrails not installed → rejected (never an unguarded bypass).
    missing: 'C412-GUARDRAILS-001',
  },
  Policy: {
    // Runtime-agnostic command policy (CYAU-25): an action violates a critical protection (production, destructive
    // DB, protected branch, force-push) → rejected by the process wrapper BEFORE the spawn, for ANY
    // runtime (claude/codex/shell). Defence in depth with the claude hooks and the codex sandbox (provider-specific).
    violation: 'C412-POLICY-001',
  },
  Classify: {
    // Not enough content to classify, or unrecognised override (category/risk): invalid
    // input (input defence, untrusted CLI override).
    invalidInput: 'C400-CLASSIFY-001',
    // High-risk ticket without human approval (CYAU-17): do NOT proceed automatically. Legitimate outcome
    // (like Lease.held), dedicated exit 3 so a shell gate does not start an unapproved risky run.
    approvalRequired: 'C409-CLASSIFY-002',
  },
  Route: {
    // Invalid routing input or override (category/capability/runtime/preference outside the known values):
    // input defence, untrusted CLI override.
    invalidInput: 'C400-ROUTE-001',
    // No usable runtime for the choice (preferred one unavailable and no fallback, or runtime
    // forced but unavailable): do NOT proceed. Legitimate outcome (like Lease.held), dedicated exit 3 so a shell
    // gate does not start an implementer on a provider that is down.
    noRuntime: 'C409-ROUTE-002',
  },
  Split: {
    // Ticket code not valid as a segment (it generates the ids/branches of the sub-runs), or classification
    // input (area/capability) outside the known values: input defence, untrusted CLI override.
    invalidInput: 'C400-SPLIT-001',
    // Gate: the integration phase cannot start yet — it waits for the completion (the gates) of the single
    // parts (CYAU-19). Legitimate outcome (like Lease.held), dedicated exit 3 so a shell gate does not start
    // the integration before the parts have passed their gates.
    integrationNotReady: 'C409-SPLIT-002',
  },
  Review: {
    // Invalid cross review input (CYAU-20/45): implementer/reviewer/base out of domain, diff
    // not fully acquirable, or reviewer equal to the implementer. Fail-closed input defence.
    invalidInput: 'C400-REVIEW-001',
    // The review requests changes: blocking (major) findings to fix → back to implementing, do NOT
    // proceed to human review. Legitimate outcome (like Lease.held), dedicated exit 3 so a shell gate does not advance
    // with open findings.
    changesRequested: 'C409-REVIEW-002',
    // The review is blocked: reviewer unavailable/timed out/cancelled/failed, malformed output or blocker
    // finding. Only a reviewer process completed with a valid report can approve. Dedicated exit 3.
    blocked: 'C409-REVIEW-003',
  },
  Cycle: {
    // Invalid cycle gate input (CYAU-21): unknown verdict, negative/non-integer cycle, limit not a
    // positive integer. Input defence, untrusted CLI override.
    invalidInput: 'C400-CYCLE-001',
    // Cycle budget exhausted: after two unapproved cycles (or a blocker finding) the run needs
    // human intervention — it is NOT repeated automatically (DoD: the workflow does not exceed two cycles). Legitimate outcome (like
    // Lease.held), dedicated exit 3 so a shell gate does not start a cycle beyond the budget.
    limitReached: 'C409-CYCLE-002',
  },
  Clarify: {
    // Invalid clarification input (CYAU-22): unparsable comments (missing file / illegal JSON / neither array
    // nor data[]), questions outside 1..3, empty reason, cycle/limit not a positive integer. Input defence,
    // untrusted CLI input.
    invalidInput: 'C400-CLARIFY-001',
    // The ticket is waiting for an answer (waiting): NOT workable now → release the slot and continue the queue
    // (DoD: a waiting ticket does not hold the execution slot). Legitimate outcome (like Lease.held), dedicated exit 3
    // so a shell gate does not keep the slot busy on a waiting ticket.
    waiting: 'C409-CLARIFY-002',
    // After two clarification cycles without a useful answer (or ticket already escalated): human intervention is needed, do NOT
    // open a third round (Technical analysis: "at most two cycles, then escalation"). Legitimate outcome, dedicated exit 3.
    escalated: 'C409-CLARIFY-003',
  },
  Gate: {
    // Invalid quality gate config (CYAU-23): illegal YAML, schema not honoured, unknown stage in
    // --only. Input defence, untrusted config/CLI. Exit 2 (invalid usage/config).
    invalidConfig: 'C400-GATE-001',
    // A REQUIRED check did not pass (failed / timed out / skipped after another required one failed): the
    // quality gate fails → do NOT proceed to review/PR (DoD). Legitimate outcome (like Lease.held), dedicated exit 3
    // so a shell gate does not advance with broken checks.
    failed: 'C409-GATE-002',
    // Quality gate config not found in the repository: no declared check to run (CYAU-23). Exit 2.
    notFound: 'C404-GATE-003',
    // Remote CI or the draft→ready promotion cannot be attested within the configured window. It is not
    // a red: the work stays undelivered and can be resumed without declaring it defective.
    unavailable: 'C503-GATE-004',
  },
  Deliver: {
    // Branch not deliverable (CYAU-24): push is allowed ONLY on `ticket/*` (consistent with the
    // guard-branch-push guardrail) — main/master/develop and the like are rejected. Input defence, untrusted input. Exit 2.
    invalidBranch: 'C400-DELIVER-001',
    // The automatic gates are NOT green: the delivery (push/PR/In Review) does not start (Scenario 1: "Given all the
    // automatic gates are green"). Legitimate outcome (like Gate.failed), dedicated exit 3 so a shell gate does not deliver
    // unverified work.
    gateNotPassed: 'C409-DELIVER-002',
    // A delivery command (git push / gh pr create / cyi) failed: delivery interrupted, best-effort. Exit 1.
    commandFailed: 'C502-DELIVER-003',
    // Invalid command input (CYAU-24): --result-file is not JSON / not a valid agent outcome, --current-phase
    // or the test counts outside the expected values. Input defence, untrusted CLI input. Exit 2.
    invalidInput: 'C400-DELIVER-004',
    // The changeset to commit is abnormal (too many files or too much weight, CYAU-142): almost always a
    // dependency install that ended up in the worktree. It stops BEFORE committing/publishing — removing it afterwards is not
    // enough, the blobs stay in history and the push fails halfway. Legitimate fail-closed outcome (like gateNotPassed). Exit 3.
    changesetTooLarge: 'C409-DELIVER-005',
  },
  Recovery: {
    // The run is NOT automatically resumable: no valid checkpoint, or local-only work
    // (dirty worktree or unpushed commit) not recoverable by another host → reported for intervention.
    // Legitimate outcome (like Lease.held), dedicated exit 3: a shell gate does not resume by mistake.
    manual: 'C409-RECOVERY-001',
    // The ticket is still held by ANOTHER host (lease not expired): do not recover, it is live work elsewhere.
    blocked: 'C409-RECOVERY-002',
  },
  Workspace: {
    // Unsafe path segment (owner/repo/project/ticket): empty, `..`, separator or hostile key.
    unsafeSegment: 'C400-WORKSPACE-001',
    // The repository/worktree path is already taken by something that is NOT a git checkout → not overwritten.
    occupied: 'C409-WORKSPACE-002',
    // Worktree and repository are nested (one inside the other's tree): invalid layout.
    nested: 'C409-WORKSPACE-003',
    // A git command (clone / worktree add) failed.
    gitFailed: 'C502-WORKSPACE-004',
    // The requested project has no GitHub repository associated among the agents → nothing to clone.
    noRepo: 'C404-WORKSPACE-005',
    // Existing checkout but remote/worktree/branch identity differs from the expected one: preserve and stop.
    mismatch: 'C409-WORKSPACE-006',
  },
  Guidance: {
    // Invalid context preparation input (CYAU-26): project key not safe as a segment (it ends up
    // in the argv of `cyi kb search -p …`). Input defence, untrusted CLI input. Exit 2. Consulting
    // the Knowledge is instead best-effort (a network failure does NOT throw: it degrades to local guidance
    // only, noting it in the package), so context preparation never blocks the run.
    invalidInput: 'C400-GUIDANCE-001',
  },
  Publish: {
    // Invalid publication input (CYAU-27): project-key/ticket/run-id not safe as a segment
    // (they end up in the argv of `cyi kb …` or in the metadata), kind outside note|decision|guide, empty title,
    // source file outside the worktree/unreadable. Input defence, untrusted CLI input. Exit 2.
    invalidInput: 'C400-PUBLISH-001',
    // The source file is NOT versioned (git-tracked): the Knowledge page would not derive from a versioned
    // file (DoD) → NOT published. Safe-by-default gate (like Deliver.gateNotPassed): commit the
    // document first. Legitimate outcome, dedicated exit 3 so a shell gate does not publish an unversioned file.
    notVersioned: 'C409-PUBLISH-002',
    // The content to publish contains a SECRET pattern (private key, token, API key): never
    // published in the Knowledge (knowledge-publishing.md "secrets never enter the page"). Defence in
    // depth on top of the "versioned files only" constraint. Gate, dedicated exit 3 (like Policy.violation).
    secretDetected: 'C412-PUBLISH-004',
    // The atomic `cyi kb publish` command failed: publication interrupted. The backend's structured error code
    // stays in the message, without echoing arbitrary stdout/stderr that could expose the body.
    commandFailed: 'C502-PUBLISH-005',
    // `cyi kb publish` ends with exit 0 but returns an incomplete or invalid atomic envelope:
    // the create/update/adoption outcome is undetermined → fail-closed. Exit 1.
    invalidResponse: 'C502-PUBLISH-006',
  },
  Book: {
    // Invalid book assignment input (CYAU-28): project-key/page-id/ticket not safe as a segment
    // (they end up in the argv of `cyi kb book …`), empty book title, or position not a positive integer.
    // Input defence, untrusted CLI input. Exit 2.
    invalidInput: 'C400-BOOK-001',
    // No book with the given title in the project: the thematic book is MISSING (DoD "the documentation task clearly
    // reports a missing book"). Automator does NOT create books (it is a human/policy decision): it reports the absence.
    // Legitimate outcome (like Publish.notVersioned), dedicated exit 3 so a shell gate does not assign to a missing book.
    absent: 'C409-BOOK-002',
    // Several books with the SAME title in the project: AMBIGUITY (DoD "clearly reports book ambiguity") → do not
    // guess which one to assign to. Human intervention needed. Legitimate outcome, dedicated exit 3.
    ambiguous: 'C409-BOOK-003',
    // A `cyi kb book` command (list/show/add-page) failed, or after the assignment the page does NOT appear
    // in the table of contents (Scenario 1: "check the position in the table of contents" failed): assignment interrupted. NOT
    // best-effort (like publish, so as not to leave the membership undetermined): stop. Exit 1.
    commandFailed: 'C502-BOOK-004',
  },
  Discovery: {
    // Invalid discovery input (CYAU-29): unknown runtime/source/impact, malformed signal
    // (missing source/evidence/impact/confidence, confidence outside [0,1], extra field), invalid budget
    // (maxSignals not a positive integer, minConfidence outside [0,1]), illegal signal JSON or unreadable
    // file. Input defence: the input comes from the CLI or from the agent output, untrusted. Exit 2.
    // Discovery is not a go/no-go gate (it produces best-effort signals): no dedicated exit 3.
    invalidInput: 'C400-DISCOVERY-001',
  },
  Dedup: {
    // Invalid deduplication input (CYAU-30): unsafe project key (it ends up in the argv of `cyi
    // tickets list`), empty repository, malformed signal (reuses discovery's parseSignal), similarity
    // thresholds outside [0,1] or weak > strong, illegal signal JSON. Input defence, untrusted CLI/
    // agent input. Exit 2.
    invalidInput: 'C400-DEDUP-001',
    // RELIABLE duplicate found (identical fingerprint or strong similarity on a single ticket): do NOT create a
    // new ticket → enrich the existing one with the composed comment (Technical analysis). Legitimate outcome (like
    // Publish.notVersioned), dedicated exit 3 so a shell gate does not create a duplicate after the CYI search.
    duplicateFound: 'C409-DEDUP-002',
    // AMBIGUOUS match (several tickets with the same fingerprint, or unreliable similarity): stays in TRIAGE for
    // human review (DoD: "ambiguous matches stay in triage"). Do NOT create or enrich automatically. Legitimate
    // outcome, dedicated exit 3.
    ambiguousMatch: 'C409-DEDUP-003',
    // The CYI duplicate search (`cyi tickets list`) failed: NOT best-effort (unlike guidance) —
    // continuing and creating the ticket would violate the DoD "no ticket created without a duplicate search" → stop
    // (like publish on the duplicate search). Exit 1.
    searchFailed: 'C502-DEDUP-004',
  },
  Limits: {
    // Invalid limits gate input (CYAU-32): --mode outside dispatch|continue, numeric values
    // (running/runs-today/cost-today/runtime-seconds/cost/runs) negative or non-numeric, illegal --policy JSON
    // or policy not matching the schema, repository not safe as a segment. Input defence, untrusted CLI/
    // server input. Exit 2.
    invalidInput: 'C400-LIMITS-001',
    // A DISPATCH limit is exceeded: slots (max_parallel) full, daily budget (runs/cost) exhausted,
    // outside the time window, kill switch active, or policy configured but NOT retrievable (fail-closed).
    // Do NOT start a new run (DoD: no host exceeds the limits). Legitimate outcome (like Lease.held), dedicated
    // exit 3 so a shell gate does not start a run beyond the limits.
    limitExceeded: 'C409-LIMITS-002',
    // A running run must be brought to a safe CHECKPOINT (CONTINUE): kill switch active, maximum runtime
    // exceeded, outside the window, or policy not retrievable (fail-closed). Do NOT interrupt brutally (DoD: active
    // runs go to a safe checkpoint, never a SIGKILL in the middle of a Git write). Legitimate outcome,
    // dedicated exit 3 so a shell gate stops the run cleanly instead of continuing.
    checkpointRequired: 'C409-LIMITS-003',
    // The daily usage is not reliable: corrupt/partial file, pending quarantine or leftover lock.
    // Gate and record fail closed; the reset requires a manual/auditable recovery, never an automatic one.
    usageUnavailable: 'C409-LIMITS-004',
  },
  Update: {
    // Invalid distribution/update input (CYAU-33): --channel outside stable|beta, version
    // (target/current) unparsable or not safe as a segment (it ends up in the `releases/<version>` path),
    // unreadable manifest. Input defence, untrusted CLI/manifest input. Exit 2.
    invalidInput: 'C400-UPDATE-001',
    // No release compatible with the server for the chosen channel (CYAU-33): the candidate version requires
    // a server outside the declared range → do NOT update (installing an incompatible client would break
    // communication with the server). Legitimate outcome (like Lease.held), dedicated exit 3 so a shell gate does not install
    // an incompatible version.
    incompatible: 'C409-UPDATE-002',
    // Update FAILED and rolled back: the `current` symlink atomically went back to the previous release,
    // target and health were verified, without changing its bytes or losing runs (DoD). The
    // system is healthy but NOT updated → legitimate outcome, dedicated exit 3 so a shell gate knows the update did not
    // update (but it is not a disaster: the previous version is active again).
    rolledBack: 'C409-UPDATE-003',
    // Update failed in a NON-recoverable way or integrity violated: wrong checksum (never extracted),
    // staging/extract/preflight/promotion failed before the switch, unverified rollback, broken manifest or
    // failed first installation without a previous one. Operational failure, exit 1.
    failed: 'C500-UPDATE-004',
  },
  Manifest: {
    // Unsafe workspace manifest path segment (CYAU OneClick): empty/absolute `path`, `..`,
    // hostile separator, `.git` or prototype key → the entry is DISCARDED (never path traversal under the
    // workspace root), best-effort per repo like the segment defences of workspace.ts. It does not block the other entries.
    invalidPath: 'C400-MANIFEST-001',
    // The destination path of a manifest repo is already taken by something that is NOT a git checkout →
    // not overwritten (it could contain the operator's work), like Workspace.occupied.
    occupied: 'C409-MANIFEST-002',
    // A git/gh workspace replication command (clone / fetch / pull --ff-only) failed: the single entry
    // stays unreplicated (best-effort), the others continue.
    gitFailed: 'C502-MANIFEST-003',
  },
  OneClick: {
    // A OneClick provisioning stage requires a HUMAN ACTION before it can continue (missing
    // toolchain → bootstrap.sh; missing device-flow auth → gh/cyi/claude/codex login). It is NOT an error: the
    // state is checkpointed and re-running `oneclick` resumes from the uncompleted stage. Legitimate outcome (like
    // Lease.held), dedicated exit 3 so a shell gate knows it must stop and restart after the human action.
    stopped: 'C409-ONECLICK-001',
    // A provisioning stage failed operationally (update/install unsuccessful): the system stays in
    // a known state (checkpoint), but OneClick did not complete. Operational failure, exit 1.
    failed: 'C500-ONECLICK-002',
  },
  Runtime: {
    // A REQUIRED agent runtime (claude) present but not usable at doctor's `--version` probe.
    unavailable: 'C000-RUNTIME-001',
  },
  // Delivery of the structured result of a host-first phase (CYAU-105). They used to be literals scattered in the runner:
  // here they sit next to the other domains, so the codes that end up in the log are searchable in one place.
  Workflow: {
    // The session ended without a result interpretable against the phase schema: the delivery does not
    // start at all (no PUT). It is not a server rejection — it is output that does not reach the contract.
    unparsable: 'C422-WORKFLOW-001',
    // The server rejected the delivery on the merits, or the cross review did not approve: the
    // attempt exists but does not advance. The HTTP status and the server code live in the `DeliveryRecord`.
    rejected: 'C409-WORKFLOW-002',
    // The delivery did not reach its destination (network, timeout, 5xx, missing credential): UNDETERMINED
    // outcome, distinct from a rejection. The server may have applied it without the response coming back.
    undelivered: 'C502-WORKFLOW-003',
  },
  System: {
    unexpected: 'C500-SYS-001',
  },
} as const

/** Automator domain error: carries a `C…` code and the exit code to use in the CLI. */
export class AutomatorError extends Error {
  readonly code: string
  readonly exitCode: number
  /** Optional structured context for the `--json` output on the error path (e.g. a gate's divergences). */
  readonly details?: Record<string, unknown>

  constructor(code: string, message: string, exitCode = 1, details?: Record<string, unknown>) {
    super(message)
    this.name = 'AutomatorError'
    this.code = code
    this.exitCode = exitCode
    this.details = details
  }
}
