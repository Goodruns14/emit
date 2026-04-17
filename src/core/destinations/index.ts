import type {
  DestinationAdapter,
  DestinationConfig,
} from "../../types/index.js";
import { SegmentDestinationAdapter } from "./segment.js";
import { AmplitudeDestinationAdapter } from "./amplitude.js";
import { MixpanelDestinationAdapter } from "./mixpanel.js";
import { SnowflakeDestinationAdapter } from "./snowflake.js";
import { loadCustomAdapter } from "./custom.js";

export { SegmentDestinationAdapter } from "./segment.js";
export { AmplitudeDestinationAdapter } from "./amplitude.js";
export { MixpanelDestinationAdapter } from "./mixpanel.js";
export { SnowflakeDestinationAdapter } from "./snowflake.js";
export { loadCustomAdapter } from "./custom.js";

/**
 * Factory for destination adapters.
 *
 * Built-in adapters (segment/amplitude/mixpanel/snowflake) are constructed
 * synchronously. Custom adapters require dynamic import, which is async —
 * hence the whole function returns a Promise.
 *
 * @param configFilePath Absolute path to emit.config.yml. Used to resolve
 *   relative `module` paths in custom destination configs.
 */
export async function createDestinationAdapter(
  config: DestinationConfig,
  configFilePath: string,
): Promise<DestinationAdapter> {
  switch (config.type) {
    case "segment":
      return new SegmentDestinationAdapter(config);
    case "amplitude":
      return new AmplitudeDestinationAdapter(config);
    case "mixpanel":
      return new MixpanelDestinationAdapter(config);
    case "snowflake":
      return new SnowflakeDestinationAdapter(config);
    case "custom":
      return loadCustomAdapter(config, configFilePath);
    default:
      throw new Error(`Unknown destination type: ${(config as any).type}`);
  }
}
