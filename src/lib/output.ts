import {redactSecrets} from './secret-redaction'

/**
 * Neutralizes terminal control sequences (CWE-150) in strings of external origin.
 * An action's output (claude/shell stdout, playbook text) can be influenced: printing a raw ESC (0x1B)
 * on a TTY allows cursor/colour/title injection. Every C0/C1 control char
 * (0x00–0x1F, 0x7F–0x9F) becomes a space — ANSI defused, width preserved.
 */
export function sanitize(value: unknown): string {
  let out = ''
  for (const ch of redactSecrets(String(value ?? ''))) {
    const code = ch.codePointAt(0) ?? 0
    out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : ch
  }

  return out
}

/** Like `sanitize`, but preserves newlines (for multi-line bodies such as an action's logs). */
export function sanitizeMultiline(value: unknown): string {
  return String(value ?? '')
    .split('\n')
    .map((line) => sanitize(line))
    .join('\n')
}

/** Minimal dependency-free table renderer, for human output. */
export function renderTable(headers: string[], rows: string[][]): string {
  const safeHeaders = headers.map(sanitize)
  const safeRows = rows.map((row) => row.map(sanitize))

  if (safeRows.length === 0) {
    return `${safeHeaders.join('  ')}\n(nessun risultato)`
  }
  const widths = safeHeaders.map((header, col) =>
    Math.max(header.length, ...safeRows.map((row) => (row[col] ?? '').length)),
  )
  const line = (cols: string[]): string =>
    cols.map((cell, col) => (cell ?? '').padEnd(widths[col])).join('  ').trimEnd()
  const separator = widths.map((width) => '-'.repeat(width))
  return [line(safeHeaders), line(separator), ...safeRows.map(line)].join('\n')
}

/** Prints the scalar fields of a record as `key: value` lines. */
export function renderRecord(obj: Record<string, unknown>): string {
  const lines = Object.entries(obj)
    .filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => `${sanitize(key)}: ${value === null ? '-' : sanitize(value)}`)
  return lines.length > 0 ? lines.join('\n') : sanitizeMultiline(JSON.stringify(obj, null, 2))
}
