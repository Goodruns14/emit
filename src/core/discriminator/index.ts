import type {
  EmitConfig,
  DiscriminatorPropertyConfig,
} from "../../types/index.js";
import { logger } from "../../utils/logger.js";

export interface DiscriminatorExpansion {
  parentEvent: string;
  property: string;
  values: string[];
  source: "config" | "code";
}

function getPropertyAndValues(
  cfg: DiscriminatorPropertyConfig
): { property: string; values?: string[] } {
  if (typeof cfg === "string") {
    return { property: cfg };
  }
  return { property: cfg.property, values: cfg.values };
}

export async function expandDiscriminators(
  config: EmitConfig,
): Promise<DiscriminatorExpansion[]> {
  if (!config.discriminator_properties) return [];

  const expansions: DiscriminatorExpansion[] = [];

  for (const [eventName, cfg] of Object.entries(config.discriminator_properties)) {
    const { property, values } = getPropertyAndValues(cfg);

    // Config-provided values
    if (values && values.length > 0) {
      expansions.push({
        parentEvent: eventName,
        property,
        values,
        source: "config",
      });
      continue;
    }

    // No values discovered — skip with a warning
    logger.warn(
      `discriminator_properties.${eventName}: no values found for "${property}". ` +
      `Add explicit values in config.`
    );
  }

  return expansions;
}
