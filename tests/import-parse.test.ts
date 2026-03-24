import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseEventsFile } from "../src/core/import/parse.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-import-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// ── CSV tests ──────────────────────────────────────────────────────────────────

describe("CSV — single column", () => {
  it("parses single column with no header", () => {
    const f = write("events.csv", "checkout_completed\nsignup_form_submitted\npage_view\n");
    const result = parseEventsFile(f);
    expect(result.events).toEqual(["checkout_completed", "signup_form_submitted", "page_view"]);
    expect(result.skipped).toBe(0);
    expect(result.format).toBe("csv");
  });

  it("strips surrounding quotes from values", () => {
    const f = write("events.csv", '"checkout_completed"\n"signup_form_submitted"\n');
    const result = parseEventsFile(f);
    expect(result.events).toEqual(["checkout_completed", "signup_form_submitted"]);
  });

  it("skips blank lines", () => {
    const f = write("events.csv", "checkout_completed\n\n   \nsignup_form_submitted\n");
    const result = parseEventsFile(f);
    expect(result.events).toEqual(["checkout_completed", "signup_form_submitted"]);
  });
});

describe("CSV — multi-column", () => {
  it("defaults to first column when no --column given", () => {
    const f = write("events.csv", "event_name,description,volume\ncheckout_completed,Order done,500\nsignup_form_submitted,User signed up,200\n");
    const result = parseEventsFile(f);
    expect(result.events).toEqual(["checkout_completed", "signup_form_submitted"]);
  });

  it("extracts named column when --column provided", () => {
    const f = write("mixpanel.csv", [
      "Entity Type,Entity Name,Entity Display,Entity Description",
      "event,SKU Provisioning Event,SKU ARR,Contains paying info",
      "event,User Signup,User Signup,Tracks signups",
      "event,Page View,Page View,Tracks page views",
    ].join("\n"));
    const result = parseEventsFile(f, { column: "Entity Name" });
    expect(result.events).toEqual(["SKU Provisioning Event", "User Signup", "Page View"]);
  });

  it("is case-insensitive for column name matching", () => {
    const f = write("events.csv", "Event Name,Description\ncheckout_completed,Order done\n");
    const result = parseEventsFile(f, { column: "event name" });
    expect(result.events).toEqual(["checkout_completed"]);
  });

  it("throws with available columns when --column not found", () => {
    const f = write("events.csv", "Entity Type,Entity Name,Entity Display\nevent,Signup,Signup\n");
    expect(() => parseEventsFile(f, { column: "Event Name" })).toThrow(
      /Column "Event Name" not found/
    );
    expect(() => parseEventsFile(f, { column: "Event Name" })).toThrow(
      /Entity Type, Entity Name, Entity Display/
    );
  });

  it("deduplicates events that appear on multiple rows", () => {
    const f = write("mixpanel.csv", [
      "Entity Type,Entity Name,Property Name",
      "event,SKU Provisioning Event,DATE_QUALIFIED",
      "event,SKU Provisioning Event,ACTIONS",
      "event,SKU Provisioning Event,EXPERIMENT_QUALIFIED",
      "event,User Signup,USER_ID",
    ].join("\n"));
    const result = parseEventsFile(f, { column: "Entity Name" });
    expect(result.events).toEqual(["SKU Provisioning Event", "User Signup"]);
    expect(result.skipped).toBe(2);
  });

  it("skips rows where the target cell is empty", () => {
    const f = write("events.csv", "Event Name,Description\n,no name here\ncheckout_completed,Order done\n");
    const result = parseEventsFile(f);
    expect(result.events).toEqual(["checkout_completed"]);
  });
});

describe("CSV — quoted values with commas", () => {
  it("handles quoted fields containing commas", () => {
    const f = write("events.csv", [
      "Event Name,Description",
      '"checkout, completed","Payment, done"',
      '"user signup","New, user"',
    ].join("\n"));
    const result = parseEventsFile(f);
    expect(result.events).toEqual(["checkout, completed", "user signup"]);
  });
});

describe("CSV — BOM handling", () => {
  it("strips BOM from start of file", () => {
    const f = write("events.csv", "\uFEFFcheckout_completed\nsignup_form_submitted\n");
    const result = parseEventsFile(f);
    expect(result.events[0]).toBe("checkout_completed");
  });
});

// ── JSON tests ─────────────────────────────────────────────────────────────────

describe("JSON — string array", () => {
  it("parses string array directly", () => {
    const f = write("events.json", JSON.stringify(["checkout_completed", "user_signup", "page_view"]));
    const result = parseEventsFile(f);
    expect(result.events).toEqual(["checkout_completed", "user_signup", "page_view"]);
    expect(result.format).toBe("json");
  });
});

describe("JSON — object array", () => {
  it("extracts 'name' field from object array", () => {
    const f = write("events.json", JSON.stringify([
      { name: "checkout_completed", description: "Order done" },
      { name: "user_signup", description: "User joined" },
    ]));
    const result = parseEventsFile(f);
    expect(result.events).toEqual(["checkout_completed", "user_signup"]);
  });

  it("extracts 'event_name' field", () => {
    const f = write("events.json", JSON.stringify([
      { event_name: "checkout_completed" },
      { event_name: "user_signup" },
    ]));
    const result = parseEventsFile(f);
    expect(result.events).toEqual(["checkout_completed", "user_signup"]);
  });
});

describe("JSON — Segment tracking plan", () => {
  it("extracts events from {events: [...]} shape", () => {
    const f = write("plan.json", JSON.stringify({
      name: "My Tracking Plan",
      events: [
        { name: "checkout_completed", description: "Order placed" },
        { name: "user_signup" },
      ],
    }));
    const result = parseEventsFile(f);
    expect(result.events).toEqual(["checkout_completed", "user_signup"]);
  });
});

describe("JSON — error cases", () => {
  it("throws a helpful message on malformed JSON", () => {
    const f = write("events.json", "{ not valid json }");
    expect(() => parseEventsFile(f)).toThrow(/Invalid JSON/);
  });
});

// ── Shared ─────────────────────────────────────────────────────────────────────

describe("shared edge cases", () => {
  it("throws on empty CSV file", () => {
    const f = write("events.csv", "");
    expect(() => parseEventsFile(f)).toThrow(/empty/i);
  });

  it("throws on empty JSON file", () => {
    const f = write("events.json", "");
    expect(() => parseEventsFile(f)).toThrow(/empty/i);
  });

  it("throws on non-existent file", () => {
    expect(() => parseEventsFile("/tmp/does-not-exist-12345.csv")).toThrow(
      /File not found/
    );
  });
});
