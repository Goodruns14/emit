import type {
  EmitConfig,
  WarehouseAdapter,
  DiscriminatorPropertyConfig,
} from "../../types/index.js";
import { logger } from "../../utils/logger.js";

export interface DiscriminatorExpansion {
  parentEvent: string;
  property: string;
  values: string[];
  source: "config" | "warehouse" | "code";
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
  warehouseAdapter: WarehouseAdapter | null,
): Promise<DiscriminatorExpansion[]> {
  if (!config.discriminator_properties) return [];

  const expansions: DiscriminatorExpansion[] = [];

  for (const [eventName, cfg] of Object.entries(config.discriminator_properties)) {
    const { property, values } = getPropertyAndValues(cfg);

    // Priority 1: Config-provided values
    if (values && values.length > 0) {
      expansions.push({
        parentEvent: eventName,
        property,
        values,
        source: "config",
      });
      continue;
    }

    // Priority 2: Warehouse discovery
    if (warehouseAdapter?.getDistinctPropertyValues) {
      try {
        const discovered = await warehouseAdapter.getDistinctPropertyValues(
          eventName,
          property,
          500
        );
        if (discovered.length > 0) {
          if (discovered.length >= 500) {
            logger.warn(
              `discriminator_properties.${eventName}: warehouse returned 500+ values for "${property}" (capped at 500). ` +
              `Consider adding explicit values in config to limit scope.`
            );
          }
          expansions.push({
            parentEvent: eventName,
            property,
            values: discovered,
            source: "warehouse",
          });
          continue;
        }
      } catch {
        // Fall through to empty
      }
    }

    // No values discovered — skip with a warning
    logger.warn(
      `discriminator_properties.${eventName}: no values found for "${property}". ` +
      `Add explicit values in config or connect a warehouse.`
    );
  }

  return expansions;
}
