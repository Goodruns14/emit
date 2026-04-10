import type {
  DestinationAdapter,
  DestinationConfig,
} from "../../types/index.js";
import { SegmentDestinationAdapter } from "./segment.js";
import { AmplitudeDestinationAdapter } from "./amplitude.js";
import { MixpanelDestinationAdapter } from "./mixpanel.js";
import { SnowflakeDestinationAdapter } from "./snowflake.js";

export { SegmentDestinationAdapter } from "./segment.js";
export { AmplitudeDestinationAdapter } from "./amplitude.js";
export { MixpanelDestinationAdapter } from "./mixpanel.js";
export { SnowflakeDestinationAdapter } from "./snowflake.js";

export function createDestinationAdapter(
  config: DestinationConfig,
): DestinationAdapter {
  switch (config.type) {
    case "segment":
      return new SegmentDestinationAdapter(config);
    case "amplitude":
      return new AmplitudeDestinationAdapter(config);
    case "mixpanel":
      return new MixpanelDestinationAdapter(config);
    case "snowflake":
      return new SnowflakeDestinationAdapter(config);
    default:
      throw new Error(`Unknown destination type: ${(config as any).type}`);
  }
}
