import {z} from 'zod'

interface ContractField<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  schema: Schema
  jsonSchema: Readonly<Record<string, unknown>>
}

type ContractFields = Record<string, ContractField>
type ContractShape<Fields extends ContractFields> = {
  [Key in keyof Fields]: Fields[Key]['schema']
}

/**
 * Keeps Zod validation and JSON Schema in the same declarative definition.
 * Adding/removing a field thus updates both representations of the contract.
 */
export function strictObjectContract<const Fields extends ContractFields>(fields: Fields) {
  const shape = Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [name, field.schema]),
  ) as ContractShape<Fields>
  const properties = Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [name, field.jsonSchema]),
  ) as {[Key in keyof Fields]: Fields[Key]['jsonSchema']}

  return {
    schema: z.object(shape).strict(),
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: Object.keys(fields) as Array<keyof Fields>,
      properties,
    },
  } as const
}
