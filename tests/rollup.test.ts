import { describe, it, expect } from "vitest";
import { rollupDiscriminators } from "../src/core/catalog/rollup.js";
import type { EmitCatalog, CatalogEvent } from "../src/types/index.js";

function makeEvent(overrides: Partial<CatalogEvent> = {}): CatalogEvent {
  return {
    description: "",
    fires_when: "",
    confidence: "high",
    confidence_reason: "",
    review_required: false,
    source_file: "",
    source_line: 0,
    all_call_sites: [],
    properties: {},
    flags: [],
    ...overrides,
  };
}

function makeCatalog(events: Record<string, CatalogEvent>): EmitCatalog {
  return {
    version: 1,
    generated_at: "2026-04-17T00:00:00Z",
    commit: "abc",
    stats: {
      events_targeted: Object.keys(events).length,
      events_located: Object.keys(events).length,
      events_not_found: 0,
      high_confidence: Object.keys(events).length,
      medium_confidence: 0,
      low_confidence: 0,
    },
    property_definitions: {},
    events,
    not_found: [],
  };
}

describe("rollupDiscriminators", () => {
  it("returns the catalog unchanged when there are no sub-events", () => {
    const catalog = makeCatalog({
      event_one: makeEvent({ description: "One" }),
      event_two: makeEvent({ description: "Two" }),
    });

    const result = rollupDiscriminators(catalog);
    expect(result).toBe(catalog); // early-exit reference equality
  });

  it("drops sub-events and folds their descriptions into the parent", () => {
    const catalog = makeCatalog({
      button_click: makeEvent({
        description: "User clicked a button",
        properties: {
          button_id: {
            description: "Identifier of the clicked button",
            edge_cases: [],
            null_rate: 0,
            cardinality: 3,
            sample_values: [],
            code_sample_values: [],
            confidence: "high",
          },
        },
      }),
      "button_click.signup_cta": makeEvent({
        description: "User clicked the signup CTA button",
        parent_event: "button_click",
        discriminator_property: "button_id",
        discriminator_value: "signup_cta",
      }),
      "button_click.add_to_cart": makeEvent({
        description: "User clicked add to cart",
        parent_event: "button_click",
        discriminator_property: "button_id",
        discriminator_value: "add_to_cart",
      }),
    });

    const result = rollupDiscriminators(catalog);

    // Sub-events are gone
    expect(result.events["button_click.signup_cta"]).toBeUndefined();
    expect(result.events["button_click.add_to_cart"]).toBeUndefined();

    // Parent exists
    expect(result.events.button_click).toBeDefined();

    // Parent description includes the sub-event block (sorted by discriminator_value)
    expect(result.events.button_click.description).toContain("User clicked a button");
    expect(result.events.button_click.description).toContain("Known `button_id` values:");
    expect(result.events.button_click.description).toContain("- add_to_cart: User clicked add to cart");
    expect(result.events.button_click.description).toContain("- signup_cta: User clicked the signup CTA button");

    // Sub-events should be listed in alphabetical order of discriminator_value (add_to_cart before signup_cta)
    const addIdx = result.events.button_click.description.indexOf("add_to_cart");
    const signupIdx = result.events.button_click.description.indexOf("signup_cta");
    expect(addIdx).toBeLessThan(signupIdx);

    // The discriminator property's description should be enriched
    expect(result.events.button_click.properties.button_id.description).toContain(
      "Identifier of the clicked button"
    );
    expect(result.events.button_click.properties.button_id.description).toContain(
      "Known values:"
    );
    expect(result.events.button_click.properties.button_id.description).toContain("add_to_cart");
    expect(result.events.button_click.properties.button_id.description).toContain("signup_cta");
  });

  it("does not mutate the input catalog", () => {
    const originalParent = makeEvent({
      description: "Original description",
      properties: {
        button_id: {
          description: "Original property desc",
          edge_cases: [],
          null_rate: 0,
          cardinality: 1,
          sample_values: [],
          code_sample_values: [],
          confidence: "high",
        },
      },
    });
    const catalog = makeCatalog({
      button_click: originalParent,
      "button_click.signup_cta": makeEvent({
        description: "Sub",
        parent_event: "button_click",
        discriminator_property: "button_id",
        discriminator_value: "signup_cta",
      }),
    });

    rollupDiscriminators(catalog);

    // Input catalog must still have the sub-event and original description
    expect(catalog.events["button_click.signup_cta"]).toBeDefined();
    expect(catalog.events.button_click.description).toBe("Original description");
    expect(catalog.events.button_click.properties.button_id.description).toBe(
      "Original property desc"
    );
  });

  it("keeps orphan sub-events whose parent is missing from the catalog", () => {
    const catalog = makeCatalog({
      "button_click.signup_cta": makeEvent({
        description: "Orphan",
        parent_event: "button_click", // parent missing from catalog
        discriminator_property: "button_id",
        discriminator_value: "signup_cta",
      }),
      other_event: makeEvent({ description: "Unrelated" }),
    });

    const result = rollupDiscriminators(catalog);

    // Orphan preserved (we don't silently drop data with nowhere to go)
    expect(result.events["button_click.signup_cta"]).toBeDefined();
    expect(result.events.other_event).toBeDefined();
  });

  it("handles a parent event where the discriminator property isn't declared on the parent", () => {
    // In practice the discriminator property should always be on the parent, but
    // be defensive: rollup shouldn't crash if it isn't.
    const catalog = makeCatalog({
      button_click: makeEvent({
        description: "Parent without declared discriminator property",
        properties: {
          /* no button_id here */
        },
      }),
      "button_click.signup_cta": makeEvent({
        description: "Signup CTA",
        parent_event: "button_click",
        discriminator_property: "button_id",
        discriminator_value: "signup_cta",
      }),
    });

    const result = rollupDiscriminators(catalog);

    // Parent description still gets enriched
    expect(result.events.button_click.description).toContain("Known `button_id` values:");
    expect(result.events.button_click.description).toContain("signup_cta");
    // And we don't invent a property that wasn't there
    expect(result.events.button_click.properties.button_id).toBeUndefined();
  });

  it("passes through non-discriminator events unchanged alongside rolled-up ones", () => {
    const catalog = makeCatalog({
      regular_event: makeEvent({ description: "Regular" }),
      button_click: makeEvent({
        description: "Parent",
        properties: {},
      }),
      "button_click.one": makeEvent({
        description: "Sub One",
        parent_event: "button_click",
        discriminator_property: "button_id",
        discriminator_value: "one",
      }),
    });

    const result = rollupDiscriminators(catalog);

    expect(result.events.regular_event).toBeDefined();
    expect(result.events.regular_event.description).toBe("Regular");
    expect(result.events.button_click).toBeDefined();
    expect(result.events["button_click.one"]).toBeUndefined();
  });

  it("sorts sub-events in stable alphabetical order regardless of input order", () => {
    const catalog = makeCatalog({
      e: makeEvent({ description: "Parent", properties: {} }),
      "e.zulu": makeEvent({
        description: "Z",
        parent_event: "e",
        discriminator_property: "k",
        discriminator_value: "zulu",
      }),
      "e.alpha": makeEvent({
        description: "A",
        parent_event: "e",
        discriminator_property: "k",
        discriminator_value: "alpha",
      }),
      "e.mike": makeEvent({
        description: "M",
        parent_event: "e",
        discriminator_property: "k",
        discriminator_value: "mike",
      }),
    });

    const result = rollupDiscriminators(catalog);

    const desc = result.events.e.description;
    const aIdx = desc.indexOf("alpha");
    const mIdx = desc.indexOf("mike");
    const zIdx = desc.indexOf("zulu");
    expect(aIdx).toBeLessThan(mIdx);
    expect(mIdx).toBeLessThan(zIdx);
  });

  it("returns a catalog object preserving all non-events fields (stats, commit, etc.)", () => {
    const catalog = makeCatalog({
      parent: makeEvent({ description: "P", properties: {} }),
      "parent.one": makeEvent({
        description: "One",
        parent_event: "parent",
        discriminator_property: "k",
        discriminator_value: "one",
      }),
    });
    catalog.commit = "deadbeef";

    const result = rollupDiscriminators(catalog);

    expect(result.version).toBe(1);
    expect(result.commit).toBe("deadbeef");
    expect(result.property_definitions).toEqual({});
    expect(result.not_found).toEqual([]);
  });

  it("handles empty properties gracefully", () => {
    const catalog = makeCatalog({
      e: makeEvent({ description: "Parent" }),
      "e.one": makeEvent({
        description: "Sub",
        parent_event: "e",
        discriminator_property: "k",
        discriminator_value: "one",
      }),
    });
    const result = rollupDiscriminators(catalog);
    expect(result.events.e.description).toContain("Known `k` values:");
    expect(result.events.e.description).toContain("- one: Sub");
  });
});
