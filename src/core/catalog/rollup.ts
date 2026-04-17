import type { EmitCatalog, CatalogEvent } from "../../types/index.js";

/**
 * Transforms a catalog by folding discriminator sub-events into their parent.
 *
 * Context: the "discriminator" feature splits a god event like `button_click`
 * (with `button_id` taking values `signup_cta`, `add_to_cart`, ...) into
 * semantic sub-events in the catalog (`button_click.signup_cta`, …). In the
 * catalog, this is correct — each sub-event has its own description and
 * meaning. But on the wire, only `button_click` ever fires; downstream
 * destinations (Mixpanel, Amplitude, Snowflake) never see `button_click.signup_cta`
 * as a distinct event name.
 *
 * This transform merges each sub-event's description into its parent:
 *   1. Appends a "Known <discriminator_property> values" block to the parent
 *      event's description, listing each sub-event's value + description.
 *   2. Enriches the discriminator property's description with the known values.
 *   3. Drops the sub-event entries from the returned catalog.
 *
 * Parent events without sub-events, and events without `parent_event` set,
 * pass through unchanged. Orphan sub-events (parent missing from the catalog)
 * also pass through unchanged — we don't silently drop data with nowhere to go.
 *
 * Used by `emit push` to produce a destination-facing catalog before handing
 * off to adapter code. Custom adapters that WANT sub-events (e.g. a Statsig
 * adapter treating each button_id value as its own metric) can opt out via
 * `include_sub_events: true` on their destination config.
 *
 * @param catalog The catalog to transform. Not mutated.
 * @returns A new catalog with sub-events rolled up into their parents.
 */
export function rollupDiscriminators(catalog: EmitCatalog): EmitCatalog {
  const events = catalog.events ?? {};

  // Identify sub-events and group by parent
  const subEventsByParent = new Map<string, [string, CatalogEvent][]>();
  const orphanSubEvents: string[] = [];

  for (const [eventName, event] of Object.entries(events)) {
    if (!event.parent_event) continue;
    if (!events[event.parent_event]) {
      orphanSubEvents.push(eventName);
      continue;
    }
    if (!subEventsByParent.has(event.parent_event)) {
      subEventsByParent.set(event.parent_event, []);
    }
    subEventsByParent.get(event.parent_event)!.push([eventName, event]);
  }

  // Early exit: no sub-events → return catalog as-is (cheap)
  if (subEventsByParent.size === 0) return catalog;

  // Build the new events map
  const newEvents: Record<string, CatalogEvent> = {};

  for (const [eventName, event] of Object.entries(events)) {
    // Drop non-orphan sub-events; they're being rolled up into their parents
    if (event.parent_event && events[event.parent_event]) continue;

    // Parent events get enriched; everything else (including orphans) copies through
    const subEvents = subEventsByParent.get(eventName);
    if (!subEvents || subEvents.length === 0) {
      newEvents[eventName] = event;
      continue;
    }

    newEvents[eventName] = enrichParent(event, subEvents);
  }

  return { ...catalog, events: newEvents };
}

/**
 * Build a description + property enrichment for a parent event based on its
 * sub-events. Sub-events are sorted by discriminator_value for stable output.
 */
function enrichParent(
  parent: CatalogEvent,
  subEvents: [string, CatalogEvent][],
): CatalogEvent {
  // Sort sub-events by discriminator_value for stable output
  const sorted = [...subEvents].sort(([, a], [, b]) =>
    (a.discriminator_value ?? "").localeCompare(b.discriminator_value ?? "")
  );

  // All sub-events should share the same discriminator_property; take the first
  // as canonical. (In the catalog writer, this is always true.)
  const discriminatorProperty = sorted[0][1].discriminator_property;
  if (!discriminatorProperty) return parent;

  // Enriched description: parent's existing description, then a block listing
  // each sub-event's value + description.
  const valueLines = sorted.map(([, sub]) => {
    const val = sub.discriminator_value ?? "";
    return `  - ${val}: ${sub.description}`;
  });

  const enrichedDescription =
    parent.description +
    `\n\nKnown \`${discriminatorProperty}\` values:\n` +
    valueLines.join("\n");

  // Enrich the discriminator property's description with the list of known values
  const newProperties = { ...parent.properties };
  const discriminatorProp = newProperties[discriminatorProperty];
  if (discriminatorProp) {
    const valuesList = sorted
      .map(([, sub]) => sub.discriminator_value)
      .filter(Boolean)
      .join(", ");
    const originalDescription = discriminatorProp.description || "";
    const enrichedPropDescription = originalDescription
      ? `${originalDescription} Known values: ${valuesList}.`
      : `Known values: ${valuesList}.`;
    newProperties[discriminatorProperty] = {
      ...discriminatorProp,
      description: enrichedPropDescription,
    };
  }

  return {
    ...parent,
    description: enrichedDescription,
    properties: newProperties,
  };
}
