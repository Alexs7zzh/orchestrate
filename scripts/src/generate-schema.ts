import { writeFile } from "node:fs/promises"

import {
  EventRecordSchema,
  jsonSchemaDocumentFor,
  PreferencesSchema,
  RunStateSchema,
  WorkflowSchema
} from "./schema.js"

const outputs = [
  ["../../references/workflow.schema.json", WorkflowSchema],
  ["../../references/preferences.schema.json", PreferencesSchema],
  ["../../references/state.schema.json", RunStateSchema],
  ["../../references/event.schema.json", EventRecordSchema]
] as const

for (const [relativePath, schema] of outputs) {
  await writeFile(
    new URL(relativePath, import.meta.url),
    `${JSON.stringify(jsonSchemaDocumentFor(schema), null, 2)}\n`
  )
}
