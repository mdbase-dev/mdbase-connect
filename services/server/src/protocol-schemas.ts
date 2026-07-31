import { z } from "zod";

export const contractRequirementSchema = z.object({
  id: z.string().trim().min(1).max(100),
  version: z.string().regex(
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  )
}).strict();

export const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const collectionContractImplementationSchema = z.object({
  type_name: z.string().min(1).max(100),
  type_version: z.number().int().positive(),
  type_path: z.string().min(1).max(500).optional(),
  digest: digestSchema,
  fields: z.record(z.string(), z.string().min(1)),
  binding: z.record(z.string(), z.unknown()).optional()
}).strict();

export const collectionContractDescriptorSchema = z.object({
  contract_type: z.literal("record"),
  id: contractRequirementSchema.shape.id,
  version: contractRequirementSchema.shape.version,
  digest: digestSchema,
  schema: z.record(z.string(), z.unknown()),
  binding_schema: z.record(z.string(), z.unknown()).optional(),
  implementations: z.array(collectionContractImplementationSchema).min(1).max(100)
}).strict();

export const contractSetupChoiceSchema = z.discriminatedUnion("mode", [
  z.object({
    contract: contractRequirementSchema,
    mode: z.literal("starter")
  }).strict(),
  z.object({
    contract: contractRequirementSchema,
    mode: z.literal("existing"),
    type_name: z.string().trim().min(1).max(100),
    type_revision: digestSchema,
    fields: z.record(z.string().min(1).max(500), z.string().min(1).max(500))
      .refine((fields) => Object.keys(fields).length <= 100, "Too many field mappings."),
    binding: z.record(z.string(), z.unknown()).optional()
  }).strict()
]);
