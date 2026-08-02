import { mkdir, writeFile } from "node:fs/promises"

import {
  InternalSupervisorDecisionSchema,
  InternalWorkflowSchema,
  jsonSchemaDocumentFor,
  PreferencesSchema,
  SupervisorDecisionSchema,
  WorkflowSchema
} from "./schema.js"

// The emitted documents under references/ are the published contract: they
// carry no test-only mock provider (that exists only in the internal schema
// variant behind ORCHESTRATE_ENABLE_MOCK_PROVIDER=1).
await writeFile(
  new URL("../../references/workflow.schema.json", import.meta.url),
  `${JSON.stringify(jsonSchemaDocumentFor(WorkflowSchema), null, 2)}\n`
)
await writeFile(
  new URL("../../references/supervisor-decision.schema.json", import.meta.url),
  `${JSON.stringify(jsonSchemaDocumentFor(SupervisorDecisionSchema), null, 2)}\n`
)

// The internal variants (published contract plus the mock provider) are
// build-time artifacts consumed by the runtime, so validation never has to
// derive a JSON Schema document from the effect schemas at run time.
await mkdir(new URL("./generated/", import.meta.url), { recursive: true })
await writeFile(
  new URL("./generated/workflow.internal.schema.json", import.meta.url),
  `${JSON.stringify(jsonSchemaDocumentFor(InternalWorkflowSchema), null, 2)}\n`
)
await writeFile(
  new URL("./generated/supervisor-decision.internal.schema.json", import.meta.url),
  `${JSON.stringify(jsonSchemaDocumentFor(InternalSupervisorDecisionSchema), null, 2)}\n`
)
await writeFile(
  new URL("./generated/preferences.internal.schema.json", import.meta.url),
  `${JSON.stringify(jsonSchemaDocumentFor(PreferencesSchema), null, 2)}\n`
)
