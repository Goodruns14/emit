import * as fs from "fs";
import * as path from "path";

export interface ParseOptions {
  column?: string; // user-specified column name for multi-column CSVs
}

export interface DiscriminatorEntry {
  eventName: string;
  property: string;
  values: string[];
}

export interface ImportResult {
  events: string[];
  skipped: number; // duplicate count
  source_file: string;
  format: "csv" | "json";
  discriminators?: DiscriminatorEntry[];
}

/**
 * Returns the header row of a multi-column CSV, or null if the file is
 * single-column (or not a CSV).
 */
export function getCsvHeaders(filePath: string): string[] | null {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return null;
  const ext = path.extname(resolved).toLowerCase();
  if (ext === ".json") return null;
  const raw = fs.readFileSync(resolved, "utf8");
  const content = raw.replace(/^\uFEFF/, "");
  const firstLine = content.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!firstLine) return null;
  const headers = splitCsvRow(firstLine);
  if (headers.length <= 1) return null;
  return headers.map((h) => h.trim());
}

export function parseEventsFile(
  filePath: string,
  opts?: ParseOptions
): ImportResult {
  const resolved = path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // Reject directories
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    throw new Error(`Expected a file but got a directory: ${filePath}`);
  }

  // Reject known binary/unsupported extensions
  const ext = path.extname(resolved).toLowerCase();
  const binaryExtensions = new Set([
    ".xlsx", ".xls", ".xlsm", ".ods",
    ".docx", ".doc", ".pdf",
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg",
    ".zip", ".tar", ".gz",
    ".exe", ".bin", ".dmg",
    ".parquet", ".avro",
    ".yml", ".yaml", ".toml", ".xml",
  ]);
  if (binaryExtensions.has(ext)) {
    const spreadsheetExts = new Set([".xlsx", ".xls", ".xlsm", ".ods"]);
    const configExts = new Set([".yml", ".yaml", ".toml", ".xml"]);
    let hint = "";
    if (spreadsheetExts.has(ext)) {
      hint = `\n  Export your spreadsheet as CSV first, then run: emit import <file>.csv`;
    } else if (configExts.has(ext)) {
      hint = `\n  This looks like a config file, not an event list. Emit import accepts .csv, .tsv, or .json files.`;
    }
    throw new Error(`Unsupported file type "${ext}". Emit import accepts .csv, .tsv, or .json files.${hint}`);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES") {
      throw new Error(`Permission denied: cannot read ${filePath}`);
    }
    throw new Error(`Failed to read file: ${(err as Error).message}`);
  }

  // Detect binary content (null bytes indicate non-text file)
  if (raw.includes("\0")) {
    throw new Error(
      `File appears to be binary, not a text file: ${filePath}\n  Emit import accepts .csv, .tsv, or .json files.`
    );
  }

  if (ext === ".json") {
    return parseJson(raw, resolved);
  } else {
    return parseCsv(raw, resolved, opts);
  }
}

// ── CSV ────────────────────────────────────────────────────────────────────────

function parseCsv(
  raw: string,
  filePath: string,
  opts?: ParseOptions
): ImportResult {
  // Strip BOM
  const content = raw.replace(/^\uFEFF/, "");

  const lines = content.split(/\r?\n/);
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);

  if (nonEmpty.length === 0) {
    throw new Error(`File is empty: ${filePath}`);
  }

  // Detect multi-column by checking if the first line contains commas
  // (outside of quotes)
  const firstLine = nonEmpty[0];
  const isMultiColumn = splitCsvRow(firstLine).length > 1;

  let names: string[];

  if (isMultiColumn) {
    names = parseMultiColumnCsv(nonEmpty, opts?.column);
  } else {
    names = parseSingleColumnCsv(nonEmpty);
  }

  const result = dedupe(names, filePath, "csv");

  if (isMultiColumn) {
    const discriminators = extractDiscriminatorsFromCsv(nonEmpty);
    if (discriminators.length > 0) result.discriminators = discriminators;
  }

  return result;
}

function parseMultiColumnCsv(lines: string[], column?: string): string[] {
  const headers = splitCsvRow(lines[0]).map((h) => h.trim());

  let colIndex: number;

  if (column) {
    colIndex = headers.findIndex(
      (h) => h.toLowerCase() === column.toLowerCase()
    );
    if (colIndex === -1) {
      throw new Error(
        `Column "${column}" not found.\nAvailable columns: ${headers.join(", ")}`
      );
    }
  } else {
    colIndex = 0;
  }

  const names: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvRow(lines[i]);
    const val = (cells[colIndex] ?? "").trim();
    if (val) names.push(val);
  }

  return names;
}

const COMMON_HEADERS = new Set([
  "event_name", "event name", "eventname",
  "event", "events",
  "name", "names",
  "track", "tracking_event",
]);

function parseSingleColumnCsv(lines: string[]): string[] {
  const names: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const val = stripQuotes(lines[i].trim());
    if (!val) continue;
    // Skip first line if it looks like a header
    if (i === 0 && COMMON_HEADERS.has(val.toLowerCase())) continue;
    names.push(val);
  }

  return names;
}

/**
 * Minimal RFC 4180 CSV row splitter.
 * Handles quoted fields that may contain commas.
 */
function splitCsvRow(row: string): string[] {
  const fields: string[] = [];
  let i = 0;

  while (i < row.length) {
    if (row[i] === '"') {
      // Quoted field
      let val = "";
      i++; // skip opening quote
      while (i < row.length) {
        if (row[i] === '"') {
          if (row[i + 1] === '"') {
            // Escaped quote
            val += '"';
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          val += row[i];
          i++;
        }
      }
      fields.push(val);
      // skip comma separator
      if (i < row.length && row[i] === ",") i++;
    } else {
      // Unquoted field
      const end = row.indexOf(",", i);
      if (end === -1) {
        fields.push(row.slice(i));
        break;
      } else {
        fields.push(row.slice(i, end));
        i = end + 1;
        // Trailing comma → empty final field
        if (i === row.length) {
          fields.push("");
          break;
        }
      }
    }
  }

  return fields;
}

function stripQuotes(s: string): string {
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).replace(/""/g, '"');
  }
  return s;
}

const DISC_PROPERTY_HEADERS = new Set(["discriminator_property", "disc_property"]);
const DISC_VALUES_HEADERS = new Set(["discriminator_values", "disc_values"]);

function extractDiscriminatorsFromCsv(lines: string[]): DiscriminatorEntry[] {
  const rawHeaders = splitCsvRow(lines[0]);
  const headers = rawHeaders.map((h) => h.trim().toLowerCase());

  const propIdx = headers.findIndex((h) => DISC_PROPERTY_HEADERS.has(h));
  const valIdx = headers.findIndex((h) => DISC_VALUES_HEADERS.has(h));

  if (propIdx === -1 || valIdx === -1) return [];

  const entries: DiscriminatorEntry[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvRow(lines[i]);
    const eventName = (cells[0] ?? "").trim();
    const property = (cells[propIdx] ?? "").trim();
    const valuesRaw = (cells[valIdx] ?? "").trim();

    if (!eventName || !property || !valuesRaw) continue;

    const values = valuesRaw.split(",").map((v) => v.trim()).filter(Boolean);
    if (values.length > 0) {
      entries.push({ eventName, property, values });
    }
  }

  return entries;
}

// ── Discriminator CSV ──────────────────────────────────────────────────────────

const DISC_CSV_EVENT_HEADERS = new Set([
  "event_name", "event", "name", "god_event",
]);
const DISC_CSV_PROP_HEADERS = new Set([
  "property", "prop", "discriminator_property",
]);
const DISC_CSV_VAL_HEADERS = new Set([
  "values", "vals", "discriminator_values",
]);

/**
 * Parse a 3-column discriminator CSV file.
 * Columns: event name, property, comma-separated values (quoted cell).
 * Header row is optional — skipped if first row matches known header names.
 */
export function parseDiscriminatorCsv(filePath: string): DiscriminatorEntry[] {
  const resolved = path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    throw new Error(`Expected a file but got a directory: ${filePath}`);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, "");
  } catch (err) {
    throw new Error(`Failed to read file: ${(err as Error).message}`);
  }

  if (!raw.trim()) {
    throw new Error(`File is empty: ${filePath}`);
  }

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let startIdx = 0;

  // Skip header row if first row looks like headers
  const firstCells = splitCsvRow(lines[0]);
  if (
    firstCells.length >= 3 &&
    DISC_CSV_EVENT_HEADERS.has(firstCells[0].trim().toLowerCase()) &&
    DISC_CSV_PROP_HEADERS.has(firstCells[1].trim().toLowerCase()) &&
    DISC_CSV_VAL_HEADERS.has(firstCells[2].trim().toLowerCase())
  ) {
    startIdx = 1;
  }

  const entries: DiscriminatorEntry[] = [];

  for (let i = startIdx; i < lines.length; i++) {
    const cells = splitCsvRow(lines[i]);
    if (cells.length < 3) continue;

    const eventName = cells[0].trim();
    const property = cells[1].trim();
    const valuesRaw = cells[2].trim();

    if (!eventName || !property || !valuesRaw) continue;

    const values = valuesRaw.split(",").map((v) => v.trim()).filter(Boolean);
    if (values.length > 0) {
      entries.push({ eventName, property, values });
    }
  }

  if (entries.length === 0) {
    throw new Error(
      `No discriminator entries found in ${filePath}.\n` +
      `  Expected 3 columns: event name, property, values\n` +
      `  Example: button_click,button_type,"signup_cta,add_to_cart,checkout"`
    );
  }

  return entries;
}

// ── Values file ────────────────────────────────────────────────────────────────

/**
 * Load a flat list of discriminator values from a file.
 * Supports single-column CSV, plain text (one value per line), and JSON arrays.
 */
export function parseValuesFile(filePath: string): string[] {
  const resolved = path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    throw new Error(`Expected a file but got a directory: ${filePath}`);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, "");
  } catch (err) {
    throw new Error(`Failed to read file: ${(err as Error).message}`);
  }

  if (!raw.trim()) {
    throw new Error(`File is empty: ${filePath}`);
  }

  const ext = path.extname(resolved).toLowerCase();

  if (ext === ".json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON in ${filePath}`);
    }
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      const values = (parsed as string[]).map((v) => v.trim()).filter(Boolean);
      if (values.length === 0) throw new Error(`No values found in ${filePath}`);
      return values;
    }
    throw new Error(`Values file must be a JSON array of strings`);
  }

  // .csv, .tsv, .txt — one value per line (single-column)
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const values: string[] = [];
  for (const line of lines) {
    const val = stripQuotes(line);
    if (val) values.push(val);
  }

  if (values.length === 0) {
    throw new Error(`No values found in ${filePath}`);
  }

  return values;
}

// ── JSON ───────────────────────────────────────────────────────────────────────

function parseJson(raw: string, filePath: string): ImportResult {
  if (!raw.trim()) {
    throw new Error(`File is empty: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${filePath}`);
  }

  const names = extractFromJson(parsed, filePath);
  return dedupe(names, filePath, "json");
}

function extractFromJson(data: unknown, filePath: string): string[] {
  // String array: ["event_a", "event_b"]
  if (Array.isArray(data) && data.every((x) => typeof x === "string")) {
    return data as string[];
  }

  // Object array: [{"name": "event_a"}, ...]
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
    return (data as Record<string, unknown>[]).map((obj) => {
      const val = obj["name"] ?? obj["event_name"] ?? obj["event"];
      if (typeof val !== "string" || !val) {
        throw new Error(
          `Could not find event name field in JSON object. Expected "name", "event_name", or "event".`
        );
      }
      return val;
    });
  }

  // Segment tracking plan: {"events": [...]}
  if (
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    "events" in (data as object)
  ) {
    const events = (data as Record<string, unknown>)["events"];
    return extractFromJson(events, filePath);
  }

  throw new Error(
    `Unrecognized JSON format in ${filePath}.\n` +
      `Expected a string array, object array with "name"/"event_name"/"event" field, ` +
      `or Segment tracking plan shape {"events": [...]}.`
  );
}

// ── Shared ─────────────────────────────────────────────────────────────────────

function dedupe(
  names: string[],
  filePath: string,
  format: "csv" | "json"
): ImportResult {
  const seen = new Set<string>();
  const events: string[] = [];
  let skipped = 0;

  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) {
      skipped++;
    } else {
      seen.add(trimmed);
      events.push(trimmed);
    }
  }

  if (events.length === 0) {
    throw new Error(`No events found in ${filePath}`);
  }

  return { events, skipped, source_file: filePath, format };
}
