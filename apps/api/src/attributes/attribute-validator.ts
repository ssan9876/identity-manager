import { z } from 'zod'

export type AttributeDataType = 'string' | 'number' | 'boolean' | 'date' | 'enum'

export interface ValidationRules {
  minLength?: number
  maxLength?: number
  pattern?: string
  min?: number
  max?: number
  options?: string[]
}

export interface AttributeDefinition {
  key: string
  label: string
  dataType: AttributeDataType
  required: boolean
  validationRules: ValidationRules
  appliesTo: 'user' | 'group'
  isActive: boolean
  syncToKeycloak: boolean
  selfEditable: boolean
}

export class AttributeValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`attribute validation failed: ${issues.join('; ')}`)
    this.name = 'AttributeValidationError'
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function fieldSchema(definition: AttributeDefinition): z.ZodTypeAny {
  const rules = definition.validationRules

  switch (definition.dataType) {
    case 'string': {
      let schema = z.string()
      if (rules.minLength !== undefined) schema = schema.min(rules.minLength)
      if (rules.maxLength !== undefined) schema = schema.max(rules.maxLength)
      if (rules.pattern !== undefined) schema = schema.regex(new RegExp(rules.pattern))
      return schema
    }
    case 'number': {
      let schema = z.number()
      if (rules.min !== undefined) schema = schema.min(rules.min)
      if (rules.max !== undefined) schema = schema.max(rules.max)
      return schema
    }
    case 'boolean':
      return z.boolean()
    case 'date':
      return z.string().regex(ISO_DATE, 'must be an ISO date (YYYY-MM-DD)')
    case 'enum': {
      const options = rules.options ?? []
      if (options.length === 0) {
        throw new Error(
          `enum attribute "${definition.key}" has no options configured`,
        )
      }
      return z.enum(options as [string, ...string[]])
    }
  }
}

/**
 * Builds a strict Zod object from the active definitions for one entity type.
 * Unknown keys are rejected: un-modelled data must never enter a record.
 */
export function buildAttributeSchema(
  definitions: AttributeDefinition[],
  appliesTo: 'user' | 'group' = 'user',
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const definition of definitions) {
    if (!definition.isActive || definition.appliesTo !== appliesTo) {
      continue
    }

    const field = fieldSchema(definition)
    shape[definition.key] = definition.required ? field : field.optional()
  }

  return z.object(shape).strict() as z.ZodType<Record<string, unknown>>
}

export function validateAttributes(
  definitions: AttributeDefinition[],
  value: unknown,
  appliesTo: 'user' | 'group' = 'user',
): Record<string, unknown> {
  const result = buildAttributeSchema(definitions, appliesTo).safeParse(value ?? {})

  if (!result.success) {
    throw new AttributeValidationError(
      result.error.issues.map((issue) => {
        const key = issue.path.join('.')
        return key.length > 0 ? `${key}: ${issue.message}` : issue.message
      }),
    )
  }

  return result.data
}
