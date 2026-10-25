import {z} from 'zod'
import {CycleDecisionSchema} from './cycle'
import {CheckResultSchema, GateVerdictSchema} from './quality-gate'
import {ReviewFindingSchema, ReviewVerdictSchema} from './review'
import {GitHubPrUrlSchema} from './github-pr-url'

// CYAU-228 — OpenCode reviews but never implements.
const ReviewerSchema = z.enum(['claude', 'codex', 'opencode'])

export const ReviewExecutionEvidenceSchema = z.object({
  status: z.enum(['completed', 'unavailable', 'timeout', 'cancelled', 'failed', 'malformed']),
  reviewer: ReviewerSchema.nullable(),
  findings: z.array(ReviewFindingSchema),
  detail: z.string().nullable(),
  attestation: z.object({
    reviewedBaseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    reviewedSnapshotTree: z.string().regex(/^[0-9a-f]{40}$/),
    reviewedDiffSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict().nullable(),
}).strict().superRefine((value, context) => {
  if (value.status === 'completed' && value.attestation === null) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ['attestation'], message: 'review completed richiede attestazione'})
  }
  if (value.status !== 'completed' && value.attestation !== null) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ['attestation'], message: 'solo review completed può avere attestazione'})
  }
})

export const GateEvidenceSchema = z.object({
  checks: z.array(CheckResultSchema),
  verdict: GateVerdictSchema,
}).strict()

export const TicketDeliveryEvidenceSchema = z.object({
  commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  branch: z.string().min(1),
  base: z.string().min(1),
  delivery: z.object({
    pushed: z.boolean(),
    prUrl: GitHubPrUrlSchema.nullable(),
    prCreated: z.boolean(),
    linked: z.boolean(),
    // CYAU-174 — no longer written, but still ACCEPTED: the schema is `.strict()`, and removing it
    // entirely would make every run interrupted by the previous version non-adoptable, since
    // that version wrote the field into it.
    cyiStatusSet: z.boolean().optional(),
  }).strict(),
  publications: z.array(z.object({
    sourceFile: z.string().min(1),
    pageId: z.string().min(1),
    publicationKey: z.string().min(1),
    action: z.enum(['create', 'update']),
  }).strict()),
}).strict()
export type TicketDeliveryEvidence = z.infer<typeof TicketDeliveryEvidenceSchema>

/** Durable evidence of the automatic gate: no output/env/secret enters the checkpoint. */
export const TicketAutomationEvidenceSchema = z.object({
  gate: GateEvidenceSchema,
  /** Immutable snapshot on which the green gate ran and which the review must attest. */
  gatedSnapshot: z.object({
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    snapshotTree: z.string().regex(/^[0-9a-f]{40}$/),
    diffSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict().nullable(),
  reviewExecution: ReviewExecutionEvidenceSchema.nullable(),
  reviewVerdict: ReviewVerdictSchema.nullable(),
  cycleDecision: CycleDecisionSchema.nullable(),
  /** Append-only progress of the CYAU-37 delivery; optional to read CYAU-36 checkpoints. */
  delivery: TicketDeliveryEvidenceSchema.nullable().optional(),
}).strict()

export type TicketAutomationEvidence = z.infer<typeof TicketAutomationEvidenceSchema>

export function coerceTicketAutomationEvidence(value: unknown): TicketAutomationEvidence | null {
  const parsed = TicketAutomationEvidenceSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
