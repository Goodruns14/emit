export type { WarehouseAdapter } from "../../types/index.js";

export { SnowflakeClient } from "./snowflake.js";
export { MonolithAdapter } from "./adapters/monolith.js";
export { PerEventAdapter } from "./adapters/per-event.js";
export { CustomAdapter } from "./adapters/custom.js";
export { CDP_PRESETS } from "./adapters/presets.js";

import type { SnowflakeWarehouseConfig, WarehouseAdapter } from "../../types/index.js";
import { SnowflakeClient } from "./snowflake.js";
import { MonolithAdapter } from "./adapters/monolith.js";
import { PerEventAdapter } from "./adapters/per-event.js";
import { CustomAdapter } from "./adapters/custom.js";

export function createWarehouseAdapter(config: SnowflakeWarehouseConfig): WarehouseAdapter {
  const client = new SnowflakeClient(config);

  switch (config.schema_type) {
    case "monolith":
      return new MonolithAdapter(client, config);
    case "per_event":
      return new PerEventAdapter(client, config);
    case "custom":
      return new CustomAdapter(client, config);
    default:
      throw new Error(`Unknown schema_type: ${(config as SnowflakeWarehouseConfig).schema_type}`);
  }
}
