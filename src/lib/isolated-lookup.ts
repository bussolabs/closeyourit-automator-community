import {execFile} from 'node:child_process'

// CYAU-238 — a name lookup in a child process, killed at the deadline. `dns.lookup` runs getaddrinfo in libuv's thread
// pool and cannot be cancelled: racing it against a timer stops the wait, not the request, which keeps doctor's process
// alive until the resolver gives up. In a child the request dies with the process. getaddrinfo, not c-ares, so the
// answer is the one the system gives (/etc/hosts, nsswitch, mDNS).

export interface LookupAddress {
  address: string
  family: number
}

/** Prints the addresses of `argv[1]` as JSON on stdout, or the error message on stderr with exit code 2. */
export const LOOKUP_SCRIPT = [
  "require('node:dns').lookup(process.argv[1], {all: true}, (error, addresses) => {",
  '  if (error) { process.stderr.write(error.message); process.exit(2) }',
  '  process.stdout.write(JSON.stringify(addresses))',
  '})',
].join('\n')

/**
 * The addresses of `hostname`, looked up in a child process that is killed (SIGKILL) after `timeoutMs`. Rejects on a
 * lookup error or when the deadline passes; either way no request is left running in this process.
 */
export function lookupIsolated(hostname: string, timeoutMs: number, script: string = LOOKUP_SCRIPT): Promise<LookupAddress[]> {
  const env = {...process.env}
  delete env.NODE_OPTIONS
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', script, '--', hostname], {env, timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true},
      (error, stdout, stderr) => {
        if (error) {
          const killed = error.killed || error.signal === 'SIGKILL'
          reject(new Error(killed ? `no answer within ${timeoutMs / 1000}s` : (String(stderr).trim() || error.message)))
          return
        }
        try {
          const parsed: unknown = JSON.parse(String(stdout))
          if (!Array.isArray(parsed)) throw new Error('not a list')
          resolve(parsed.filter((entry): entry is LookupAddress =>
            typeof entry?.address === 'string' && typeof entry?.family === 'number'))
        } catch {
          reject(new Error('unreadable lookup answer'))
        }
      })
  })
}
