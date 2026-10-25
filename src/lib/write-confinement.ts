import {execFile} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Attestation of WRITE confinement (CYAU-67). It answers a single question: on THIS host does the
// operating system really prevent a command from writing outside its perimeter?
//
// The real confinement of the skill-mode sessions is NOT implemented here: it is the Claude CLI's native sandbox,
// injected fail-closed into the guardrail settings (guardrails.ts, `sandbox` block) and pinned in the generationId.
// This module does not wrap, launch or configure anything of those sessions: it probes the MECHANISM that
// protects them, and gives a verdict the gates use to NOT turn on skill-mode when the proof is missing.
//
// WHAT IT DOES NOT ATTEST. The verdict concerns the confinement of writes on the FILESYSTEM, not
// the unreachability of every way out. Inside the perimeter the Unix sockets
// already existing on the host stay reachable — `/var/run/docker.sock`, the D-Bus system bus — and whoever can talk to them
// can make a PRIVILEGED service perform arbitrary writes the enclosure does not see: the
// write is performed by that service, not by the confined process. The real perimeter of the sessions is the native sandbox
// of the Claude CLI (`guardrails.ts`, `sandbox` block with its network allowlist): this module
// probes the MECHANISM that supports it and nothing more. An `attested: true` means "the kernel of
// this host can confine writes", not "there is no way out from here".
//
// The proof is DOUBLE, and the pair is the point:
//  1. positive  - writing INSIDE the perimeter must SUCCEED. Without it, a missing `bwrap` or an invalid
//     configuration would produce exactly the same observable result as a perfect confinement (failed command,
//     file never created) and we would attest a non-existent enclosure.
//  2. negative  - writing OUTSIDE must be rejected AND not leave the file.
// Attested only if both give the expected outcome. Any other case - exception, timeout, platform without a probe -
// counts as NOT attested: the cost of a false negative is skill-mode off, that of a false positive is an
// uncontained agent.

/** System bubblewrap: same PATH rule, for the same reason. */
const BWRAP = '/usr/bin/bwrap'
const PROBE_TIMEOUT_MS = 5000
const PROBE_MAX_BYTES = 4096

/** Outcome of a single confined probe: `status` 0 = the command could write. */
export interface ConfinedRunOutcome {
  status: number | null
}

export interface WriteConfinementIo {
  platform: NodeJS.Platform
  /**
   * Runs `command args` with WRITES confined to `allowedDir`. The abstraction is the PERIMETER, not
   * the profile: bubblewrap expresses it as bind arguments. Every IO builds its own enclosure.
   * It must never throw for a non-zero exit: that is data.
   */
  runConfined(allowedDir: string, command: string, args: string[]): ConfinedRunOutcome | Promise<ConfinedRunOutcome>
  /** Creates the probe root with the `inside` and `outside` subfolders; returns a CANONICAL path. */
  makeProbeRoot(): string
  exists(file: string): boolean
  remove(dir: string): void
}

export interface WriteConfinementAttestation {
  attested: boolean
  /** Readable reason when not attested: it ends up in the preflight audit and in the install rejection. */
  detail?: string
}

function quote(value: string): string {
  return JSON.stringify(value)
}

/**
 * Bubblewrap arguments of the probe: the minimal enclosure expressed as binds.
 * `--ro-bind / /` makes the whole filesystem read-only, `--bind` reopens for writing only the
 * allowed subtree. The ORDER is the substance: inverting them would leave everything writable.
 *
 * No `--dev`. It looks harmless — it is the usual bwrap idiom — but it mounts a NEW, WRITABLE
 * devtmpfs over the read-only root: a command inside the enclosure really writes to `/dev/…`, i.e.
 * OUTSIDE the perimeter, and the probe would attest a global confinement that is not there. Verified in the
 * field: with `--dev` the write to `/dev` SUCCEEDS, without it it is denied and the positive proof keeps
 * succeeding. `--ro-bind / /` already exposes `/dev` read-only, which is enough for a millisecond probe.
 *
 * No `--tmpfs /tmp` for the mirror reason: the probe root lives under `tmpdir()`, and a tmpfs would
 * mask it, making the positive proof fail forever — a healthy host would come out not attested.
 *
 * `--unshare-pid --proc /proc` instead ARE needed, and it is the opposite case to `--dev`. With `--ro-bind` alone
 * the host's `/proc` stays visible, and `/proc/<pid>/root/<path>` resolves through the mount
 * namespace of an EXTERNAL process: one writes outside the enclosure going through init's root, bypassing
 * the read-only bind. Verified in the field: without these two options the write via `/proc/1/root`
 * SUCCEEDS and all the host's processes are visible; with them it is denied and 4 stay visible.
 * The procfs mounted here does not reopen the `--dev` problem: it does not allow creating arbitrary files.
 */
export function composeBwrapArgs(allowedDir: string, command: string, args: string[]): string[] {
  if (!path.isAbsolute(allowedDir)) throw new Error('bind write-confinement: path consentito non assoluto')
  return [
    '--ro-bind', '/', '/',
    // Order: the new proc must be mounted AFTER the read-only root, otherwise the ro-bind would cover it
    // with the host's one and the `/proc/<pid>/root` gap would stay open.
    '--unshare-pid',
    '--proc', '/proc',
    // The probe timeout kills the `bwrap` process, not what lives inside the namespace: without
    // this option a timed-out probe can leave live descendants, and in a long-running daemon
    // they become orphans that pile up at every tick.
    '--die-with-parent',
    '--bind', allowedDir, allowedDir,
    // Explicit separator: without it, a command argument starting with `--` would be read by
    // bwrap as one of its options, widening the enclosure instead of being run inside it.
    '--', command, ...args,
  ]
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Runs the pair of probes and returns the verdict. It never throws: every error becomes `attested:false`. */
export async function attestWriteConfinement(
  io: WriteConfinementIo = defaultWriteConfinementIo(),
): Promise<WriteConfinementAttestation> {
  if (io.platform !== 'linux') {
    return {
      attested: false,
      detail: `write-confinement disponibile esclusivamente su Linux con bubblewrap; piattaforma ${io.platform} non supportata`,
    }
  }

  let root: string | undefined
  try {
    root = io.makeProbeRoot()
    const insideFile = path.join(root, 'inside', 'allowed')
    const outsideFile = path.join(root, 'outside', 'denied')
    const allowedDir = path.join(root, 'inside')

    const allowed = await io.runConfined(allowedDir, '/bin/sh', ['-c', `printf ok > ${quote(insideFile)}`])
    if (allowed.status !== 0 || !io.exists(insideFile)) {
      return {attested: false, detail: 'sonda non eseguita: la scrittura consentita dentro il perimetro e fallita'}
    }

    const denied = await io.runConfined(allowedDir, '/bin/sh', ['-c', `printf x > ${quote(outsideFile)}`])
    if (denied.status === 0) return {attested: false, detail: 'scrittura fuori dal perimetro consentita dal sistema'}
    // The denial must be ATTRIBUTABLE to the enclosure: a null `status` means the probe returned no
    // outcome (timeout with SIGKILL, maxBuffer, failed spawn). In that case the outside file is missing because the command
    // never ran, not because the kernel denied it: treating it as a denial would be fail-open.
    if (denied.status === null) {
      return {attested: false, detail: 'prova negativa non conclusiva: la sonda non ha restituito un esito'}
    }
    if (io.exists(outsideFile)) return {attested: false, detail: 'scrittura fuori dal perimetro ha lasciato il file'}

    return {attested: true}
  } catch (error) {
    return {attested: false, detail: `sonda write-confinement fallita: ${describeError(error)}`}
  } finally {
    if (root !== undefined) {
      // The cleanup cannot overturn an already given verdict: a leftover temp dir is not a security problem.
      try {
        io.remove(root)
      } catch {
        // deliberately ignored
      }
    }
  }
}

/**
 * Memoized attester: one probe per process, not one per ticket. The state lives in the closure and not in a
 * global module, so every test builds its own without contaminating the others.
 */
export function createWriteConfinementAttestor(
  io: WriteConfinementIo = defaultWriteConfinementIo(),
): () => Promise<WriteConfinementAttestation> {
  let probe: Promise<WriteConfinementAttestation> | undefined
  return () => (probe ??= attestWriteConfinement(io))
}

/** Converts the verdict into the rejection of an explicit turn-on (`install --skills-enabled`). */
export function requireWriteConfinementForSkillMode(attestation: WriteConfinementAttestation): void {
  if (attestation.attested) return
  throw new Error(
    `write-confinement OS non attestabile su questo host: ${attestation.detail ?? 'motivo non disponibile'}`,
  )
}

/** Runs the probe with a system binary. A non-zero exit is DATA, not an error to propagate. */
function runProbe(binary: string, argv: string[]): Promise<ConfinedRunOutcome> {
  return new Promise<ConfinedRunOutcome>((resolve) => {
    execFile(binary, argv, {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BYTES,
      killSignal: 'SIGKILL',
      env: {PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C'},
    }, (error) => {
      resolve({status: error === null ? 0 : typeof error.code === 'number' ? error.code : null})
    })
  })
}

export function defaultWriteConfinementIo(): WriteConfinementIo {
  const platform = process.platform
  return {
    platform,
    makeProbeRoot() {
      // The canonical path keeps binds and checks from observing two different aliases of the same directory.
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'automator-confinement-')))
      fs.mkdirSync(path.join(root, 'inside'))
      fs.mkdirSync(path.join(root, 'outside'))
      return root
    },
    exists: fs.existsSync,
    remove: (dir) => fs.rmSync(dir, {recursive: true, force: true}),
    runConfined(allowedDir, command, args) {
      // If the binary is missing execFile fails, the positive proof does not succeed and the verdict stays negative.
      return runProbe(BWRAP, composeBwrapArgs(allowedDir, command, args))
    },
  }
}
