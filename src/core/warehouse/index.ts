export type { WarehouseAdapter } from "../../types/index.js";

export { SnowflakeClient } from "./snowflake.js";
export { SegmentMonolithAdapter } from "./adapters/segment-monolith.js";
export { SegmentPerEventAdapter } from "./adapters/segment-per-event.js";
export { CustomAdapter } from "./adapters/custom.js";

import type { SnowflakeWarehouseConfig, WarehouseAdapter } from "../../types/index.js";
import { SnowflakeClient } from "./snowflake.js";
import { SegmentMonolithAdapter } from "./adapters/segment-monolith.js";
import { SegmentPerEventAdapter } from "./adapters/segment-per-event.js";
import { CustomAdapter } from "./adapters/custom.js";

export function createWarehouseAdapter(config: SnowflakeWarehouseConfig): WarehouseAdapter {
  const client = new SnowflakeClient(config);

  switch (config.schema_type) {
    case "segment_monolith":
      return new SegmentMonolithAdapter(client, config);
    case "segment_per_event":
      return new SegmentPerEventAdapter(client, config);
    case "custom":
      return new CustomAdapter(client, config);
    default:
      throw new Error(`Unknown schema_type: ${(config as SnowflakeWarehouseConfig).schema_type}`);
  }
}
