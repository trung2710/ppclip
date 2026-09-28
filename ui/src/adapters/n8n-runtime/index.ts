import type { UIAdapterModule } from "../types";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { parseN8nRuntimeStdoutLine } from "@paperclipai/adapter-n8n-runtime/ui";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "../schema-config-fields";

export const n8nRuntimeUIAdapter: UIAdapterModule = {
  type: "n8n_runtime",
  label: "n8n Runtime",
  parseStdoutLine: parseN8nRuntimeStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: (values: CreateConfigValues) => buildSchemaAdapterConfig(values),
};
