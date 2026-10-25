import * as fs from 'node:fs'
import {parse} from 'yaml'
import {type ZodError} from 'zod'
import {type Playbook, PlaybookSchema} from './schema'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

export interface ValidationIssue {
  path: string
  message: string
}

export type ValidationResult =
  | {ok: true; playbook: Playbook}
  | {ok: false; code: string; issues: ValidationIssue[]}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Shallow merge of `defaults` into every action (the action wins) and removal of the `defaults` key. */
function applyDefaults(doc: unknown): unknown {
  if (!isRecord(doc)) return doc
  const {defaults, actions, ...rest} = doc
  if (!isRecord(actions)) return doc // let zod report a missing/invalid `actions`
  const def = isRecord(defaults) ? defaults : {}
  const merged: Record<string, unknown> = {}
  for (const [name, action] of Object.entries(actions)) {
    merged[name] = isRecord(action) ? {...def, ...action} : action
  }
  return {...rest, actions: merged}
}

function formatIssues(err: ZodError): ValidationIssue[] {
  return err.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }))
}

/** Reads and validates a playbook without throwing: returns the typed result (used by `validate`). */
export function validatePlaybook(file: string): ValidationResult {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return {ok: false, code: ErrorCodes.Playbook.notFound, issues: [{path: '(file)', message: `Playbook non trovato: ${file}`}]}
  }

  let doc: unknown
  try {
    doc = parse(raw)
  } catch (error) {
    return {
      ok: false,
      code: ErrorCodes.Playbook.parse,
      issues: [{path: '(yaml)', message: (error as Error).message}],
    }
  }

  const result = PlaybookSchema.safeParse(applyDefaults(doc))
  if (!result.success) {
    return {ok: false, code: ErrorCodes.Playbook.invalid, issues: formatIssues(result.error)}
  }

  return {ok: true, playbook: result.data}
}

/** Loads a valid playbook or throws `AutomatorError` (exit 2 = invalid playbook/usage). */
export function loadPlaybook(file: string): Playbook {
  const result = validatePlaybook(file)
  if (result.ok) return result.playbook
  const summary = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
  throw new AutomatorError(result.code, summary, 2)
}
