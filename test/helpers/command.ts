import {Config} from '@oclif/core'
import {fileURLToPath} from 'node:url'
import {expect, vi} from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))

let cached: Config | undefined

/** Loads the real oclif Config once (reads package.json). Cached across tests. */
export async function testConfig(): Promise<Config> {
  cached ??= await Config.load(root)
  return cached
}

export interface Captured {
  stdout: () => string
  stderr: () => string
  restore: () => void
}

/** Cattura stdout/stderr: oclif instrada log/logToStderr su console.log/console.error. */
export function capture(): Captured {
  const out: string[] = []
  const err: string[] = []
  const line = (args: unknown[]): string => args.map((a) => String(a)).join(' ')
  const outSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(line(args))
  })
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(line(args))
  })
  return {
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
    restore() {
      outSpy.mockRestore()
      errSpy.mockRestore()
    },
  }
}

type Runnable = {run(argv: string[], config: Config): Promise<unknown>}

/** Runs a command class with argv against the shared Config; returns the resolved value. */
export async function run(command: Runnable, argv: string[] = []): Promise<unknown> {
  const config = await testConfig()
  return command.run(argv, config)
}

/** Runs a command with captured stdout. Returns the resolved value + the stdout. */
export async function runCaptured(command: Runnable, argv: string[] = []): Promise<{result: unknown; stdout: string}> {
  const cap = capture()
  try {
    const result = await run(command, argv)
    return {result, stdout: cap.stdout()}
  } finally {
    cap.restore()
  }
}

/** Runs a command expecting a non-zero exit; asserts the exit code and returns stderr/stdout. */
export async function runExpectingExit(
  command: Runnable,
  argv: string[],
  expectedExit = 1,
): Promise<{error: unknown; message: string; stderr: string; stdout: string}> {
  const cap = capture()
  try {
    const error = await run(command, argv).then(
      () => {
        throw new Error('the command was expected to exit non-zero, but it ended successfully')
      },
      (err: unknown) => err,
    )
    expect((error as {oclif?: {exit?: number}}).oclif?.exit).toBe(expectedExit)
    const stderr = cap.stderr()
    return {error, message: `${stderr}\n${(error as Error)?.message ?? ''}`, stderr, stdout: cap.stdout()}
  } finally {
    cap.restore()
  }
}
