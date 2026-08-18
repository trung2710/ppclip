import type { ServerAdapterModule } from "./types.js";
import { createServerAdapter } from "./server/index.js";
export { agentConfigurationDoc, label, models, type } from "./metadata.js";

export { createServerAdapter };

export default function createDefaultServerAdapter(): ServerAdapterModule {
  return createServerAdapter();
}
