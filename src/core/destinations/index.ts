import type {
  DestinationAdapter,
  DestinationConfig,
} from "../../types/index.js";
import { MixpanelDestinationAdapter } from "./mixpanel.js";
import { SnowflakeDestinationAdapter } from "./snowflake.js";
import { BigQueryDestinationAdapter } from "./bigquery.js";
import { DatabricksDestinationAdapter } from "./databricks.js";
import { loadCustomAdapter } from "./custom.js";

export { MixpanelDestinationAdapter } from "./mixpanel.js";
export { SnowflakeDestinationAdapter } from "./snowflake.js";
export { BigQueryDestinationAdapter } from "./bigquery.js";
export { DatabricksDestinationAdapter } from "./databricks.js";
export { loadCustomAdapter } from "./custom.js";

/**
 * Factory for destination adapters.
 *
 * Built-in adapters (Mixpanel, Snowflake) are constructed synchronously.
 * Custom adapters require dynamic import, which is async — hence the whole
 * function returns a Promise.
 *
 * For anything other than Mixpanel or Snowflake, use `type: custom` with a
 * `module:` path pointing at your own adapter file (.mjs/.js). See
 * docs/DESTINATIONS.md for the authoring contract.
 *
 * @param configFilePath Absolute path to emit.config.yml. Used to resolve
 *   relative `module` paths in custom destination configs.
 */
export async function createDestinationAdapter(
  config: DestinationConfig,
  configFilePath: string,
): Promise<DestinationAdapter> {
  switch (config.type) {
    case "mixpanel":
      return new MixpanelDestinationAdapter(config);
    case "snowflake":
      return new SnowflakeDestinationAdapter(config);
    case "bigquery":
      return new BigQueryDestinationAdapter(config);
    case "databricks":
      return new DatabricksDestinationAdapter(config);
    case "custom":
      return loadCustomAdapter(config, configFilePath);
    default: {
      const type = (config as any).type;
      // Helpful hint for users who had Segment/Amplitude/RudderStack as
      // built-ins in earlier versions — those are now written as custom adapters.
      const legacyNote = ["segment", "amplitude", "rudderstack"].includes(type)
        ? ` Was a built-in in earlier versions; see docs/DESTINATIONS.md for how to migrate '${type}' to a 'type: custom' adapter.`
        : "";
      throw new Error(
        `Unknown destination type: ${type}. Use 'custom' with a module path for user-authored adapters.${legacyNote}`,
      );
    }
  }
}
