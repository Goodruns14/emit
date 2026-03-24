import { describe, it, expect } from "vitest";
import { formatComment } from "../src/core/diff/format.js";
import type { CatalogDiff } from "../src/types/index.js";

function emptyDiff(): CatalogDiff {
  return { added: [], removed: [], modified: [], low_confidence: [] };
}

describe("formatComment", () => {
  it("shows no-changes message for empty diff", () => {
    const result = formatComment(emptyDiff());
    expect(result).toContain("<!-- emit-catalog-check -->");
    expect(result).toContain("No catalog changes detected in this PR.");
  });

  it("formats added events", () => {
    const diff: CatalogDiff = {
      ...emptyDiff(),
      added: [
        {
          event: "checkout_completed",
          type: "added",
          description: "User completes checkout",
          confidence: "high",
          confidence_changed: false,
          property_changes: [],
          fields_changed: [],
        },
      ],
    };
    const result = formatComment(diff);
    expect(result).toContain("**New events (1):**");
    expect(result).toContain("**checkout_completed** — User completes checkout");
  });

  it("formats modified events with description change", () => {
    const diff: CatalogDiff = {
      ...emptyDiff(),
      modified: [
        {
          event: "purchase_completed",
          type: "modified",
          description: "Updated desc",
          previous_description: "Old desc",
          confidence: "high",
          confidence_changed: false,
          property_changes: [],
          fields_changed: ["description"],
        },
      ],
    };
    const result = formatComment(diff);
    expect(result).toContain("**Modified (1):**");
    expect(result).toContain("**purchase_completed**");
    expect(result).toContain("> before: Old desc");
    expect(result).toContain("> after: Updated desc");
  });

  it("formats modified events with property changes", () => {
    const diff: CatalogDiff = {
      ...emptyDiff(),
      modified: [
        {
          event: "purchase_completed",
          type: "modified",
          description: "Same",
          confidence: "high",
          confidence_changed: false,
          property_changes: [
            {
              property: "bill_amount",
              type: "modified",
              before: "Total in cents",
              after: "Total in cents. Negative = refund.",
            },
          ],
          fields_changed: [],
        },
      ],
    };
    const result = formatComment(diff);
    expect(result).toContain("`bill_amount` description updated");
    expect(result).toContain("> before: Total in cents");
    expect(result).toContain("> after: Total in cents. Negative = refund.");
  });

  it("formats removed events", () => {
    const diff: CatalogDiff = {
      ...emptyDiff(),
      removed: [
        {
          event: "legacy_event",
          type: "removed",
          description: "Old tracking event",
          confidence: "high",
          confidence_changed: false,
          property_changes: [],
          fields_changed: [],
        },
      ],
    };
    const result = formatComment(diff);
    expect(result).toContain("**Removed (1):**");
    expect(result).toContain("~~legacy_event~~");
  });

  it("formats low confidence warnings", () => {
    const diff: CatalogDiff = {
      ...emptyDiff(),
      added: [
        {
          event: "refund_initiated",
          type: "added",
          description: "Refund started",
          confidence: "low",
          confidence_changed: false,
          property_changes: [],
          fields_changed: [],
        },
      ],
      low_confidence: [
        {
          event: "refund_initiated",
          property: "reason_code",
          confidence_reason: "insufficient context",
          source_file: "src/refunds/initiate.ts",
          source_line: 34,
        },
      ],
    };
    const result = formatComment(diff);
    expect(result).toContain("**Low confidence — review recommended (1):**");
    expect(result).toContain("`reason_code`");
    expect(result).toContain("insufficient context");
    expect(result).toContain("`src/refunds/initiate.ts:34`");
  });

  it("formats confidence change on modified event", () => {
    const diff: CatalogDiff = {
      ...emptyDiff(),
      modified: [
        {
          event: "ev",
          type: "modified",
          description: "Same",
          confidence: "low",
          confidence_changed: true,
          previous_confidence: "high",
          property_changes: [],
          fields_changed: ["confidence"],
        },
      ],
    };
    const result = formatComment(diff);
    expect(result).toContain("confidence: high → low");
  });
});
