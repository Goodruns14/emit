import type {
  DestinationAdapter,
  EmitCatalog,
  PushOpts,
  PushResult,
  BigQueryDestinationConfig,
  CatalogEvent,
  PropertyDefinition,
} from "../../types/index.js";
import {
  BigQueryClient,
  type BigQueryField,
  type BigQueryTableMetadata,
} from "./bigquery-client.js";
import { CDP_PRESETS } from "./presets.js";
import { formatEventList } from "../catalog/rollup.js";

/** Only allow unambiguous identifiers we'll interpolate into SQL. */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertSafeIdent(name: string, kind: string): void {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(
      `Invalid BigQuery ${kind}: "${name}". Must match [A-Za-z_][A-Za-z0-9_]*.`,
    );
  }
}

/**
 * Default naming convention: map an event name to a BigQuery table name.
 * BigQuery columns/tables are conventionally snake_case (unlike Snowflake's
 * uppercase), so we lowercase.
 */
function eventToTable(eventName: string): string {
  return eventName.toLowerCase().replace(/[-.\s]/g, "_");
}

/** Map a property name to a BigQuery column name. */
function propToColumn(propName: string): string {
  return propName.toLowerCase();
}

/**
 * Split "dataset.table" into (datasetPrefix, table). Bare table names return
 * (undefined, input) so the caller can substitute the destination's default
 * dataset.
 */
function splitQualified(name: string): { datasetPrefix?: string; table: string } {
  const idx = name.indexOf(".");
  if (idx === -1) return { table: name };
  return {
    datasetPrefix: name.slice(0, idx),
    table: name.slice(idx + 1),
  };
}

export class BigQueryDestinationAdapter implements DestinationAdapter {
  name = "BigQuery";
  private config: BigQueryDestinationConfig;
  private resolvedProjectId: string;
  private resolvedDataset: string;
  private resolvedLocation?: string;
  private resolvedKeyFile?: string;

  constructor(config: BigQueryDestinationConfig) {
    this.config = config;

    this.resolvedProjectId =
      config.project_id ??
      process.env.GOOGLE_CLOUD_PROJECT ??
      process.env.GCLOUD_PROJECT ??
      "";
    this.resolvedDataset = config.dataset ?? process.env.BIGQUERY_DATASET ?? "";
    this.resolvedLocation = config.location ?? process.env.BIGQUERY_LOCATION;
    this.resolvedKeyFile = config.key_file ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;

    const missing: string[] = [];
    if (!this.resolvedProjectId) missing.push("project_id");
    if (!this.resolvedDataset) missing.push("dataset");

    if (missing.length > 0) {
      throw new Error(
        `Missing BigQuery config: ${missing.join(", ")}.\n` +
          "  Set them in the destination config or via GOOGLE_CLOUD_PROJECT / BIGQUERY_DATASET.\n" +
          "  Credentials resolve from `key_file`, GOOGLE_APPLICATION_CREDENTIALS, or ADC\n" +
          "  (gcloud auth application-default login). The caller needs roles/bigquery.dataEditor\n" +
          "  on the dataset and roles/bigquery.jobUser on the project.",
      );
    }

    assertSafeIdent(this.resolvedDataset, "dataset");
  }

  /**
   * Build the exclude-column set. CDP_PRESETS stores uppercase names (shared
   * with Snowflake); BigQuery columns are lowercase, so we normalize both
   * sides to lowercase for comparison.
   */
  private getExcludeColumns(): Set<string> {
    const key = this.config.cdp_preset ?? "none";
    const preset = CDP_PRESETS[key] ?? CDP_PRESETS["none"];
    const cols = new Set<string>();
    for (const c of preset.per_event.exclude_columns) cols.add(c.toLowerCase());
    // Per-event tables may carry redundant event-name columns
    cols.add("event");
    cols.add("event_text");
    if (this.config.exclude_columns) {
      for (const col of this.config.exclude_columns) cols.add(col.toLowerCase());
    }
    return cols;
  }

  /**
   * Per-event mode: resolve the table name for a catalog event.
   * `event_table_mapping` (if present) wins unconditionally.
   */
  private resolveEventTableName(eventName: string): string {
    const mapping = this.config.event_table_mapping;
    if (mapping && mapping[eventName]) return mapping[eventName];
    return eventToTable(eventName);
  }

  /**
   * Build a BigQueryClient using the resolved credentials.
   * Exposed for testing — the client can be overridden via dependency injection.
   */
  createClient(): BigQueryClient {
    return new BigQueryClient({
      projectId: this.resolvedProjectId,
      keyFilename: this.resolvedKeyFile,
      location: this.resolvedLocation,
    });
  }

  async push(catalog: EmitCatalog, opts: PushOpts = {}): Promise<PushResult> {
    const result: PushResult = { pushed: 0, skipped: 0, skipped_events: [], errors: [] };
    const events = catalog.events ?? {};
    const targetEvents = opts.events
      ? Object.fromEntries(
          Object.entries(events).filter(([name]) => opts.events!.includes(name)),
        )
      : events;

    if (opts.dryRun) {
      result.pushed = Object.keys(targetEvents).length;
      return result;
    }

    if (this.config.schema_type === "multi_event") {
      return this.pushMultiEvent(catalog, targetEvents, result);
    }

    return this.pushPerEvent(targetEvents, result);
  }

  /**
   * Per-event push: one table per catalog event.
   *
   * For each matched table we fetch its current metadata, build a new
   * `schema.fields` array with descriptions attached to the relevant columns
   * (respecting excludes + event_table_mapping), and write it all back in a
   * single `setTableMetadata` call. One API op per table, regardless of how
   * many columns — this sidesteps BigQuery's 5-metadata-updates-per-10-sec
   * quota that a per-column ALTER loop would trigger.
   */
  private async pushPerEvent(
    targetEvents: Record<string, CatalogEvent>,
    result: PushResult,
  ): Promise<PushResult> {
    const client = this.createClient();
    const dataset = this.resolvedDataset;
    const excludeColumns = this.getExcludeColumns();

    // Pre-fetch existing tables in the dataset for efficient lookup.
    const tableRows = await client.query(
      `SELECT table_name FROM \`${this.resolvedProjectId}.${dataset}.INFORMATION_SCHEMA.TABLES\` ` +
        `WHERE table_type = 'BASE TABLE'`,
    );
    const existingTables = new Set(tableRows.map((r: any) => r.table_name as string));

    for (const [eventName, event] of Object.entries(targetEvents)) {
      const tableName = this.resolveEventTableName(eventName);

      if (!existingTables.has(tableName)) {
        result.skipped++;
        result.skipped_events.push({
          event: eventName,
          looked_for: tableName,
          possible_matches: [],
        });
        continue;
      }

      try {
        assertSafeIdent(tableName, "table name");

        const tableDescription = event.fires_when
          ? `${event.description} Fires when: ${event.fires_when}`
          : event.description;

        // Build the property-description lookup for this event.
        const propDescriptionsByColumn = new Map<string, string>();
        for (const [propName, propMeta] of Object.entries(event.properties ?? {})) {
          const columnName = propToColumn(propName);
          if (excludeColumns.has(columnName)) continue;
          propDescriptionsByColumn.set(columnName, propMeta.description);
        }

        // Merge descriptions onto the existing schema so unrelated fields
        // (modes, types, nested STRUCT fields, policy tags) are preserved.
        const current = await client.getTableMetadata(dataset, tableName);
        const newFields: BigQueryField[] = (current.schema?.fields ?? []).map((f) => {
          const desc = propDescriptionsByColumn.get(f.name);
          if (desc === undefined) return f;
          return { ...f, description: desc };
        });

        await client.setTableMetadata(dataset, tableName, {
          description: tableDescription,
          schema: { fields: newFields },
        });

        result.pushed++;
      } catch (err: any) {
        result.errors.push(`${eventName}: ${err.message}`);
      }
    }

    return result;
  }

  /**
   * Multi-event push: one table holding rows for multiple events, with
   * `event_column` discriminating rows by event type.
   *
   * Writes everything (table description, event-column description,
   * per-property column descriptions, properties-column pointer) in a single
   * `setTableMetadata` call for the same rate-limit reason as pushPerEvent.
   */
  private async pushMultiEvent(
    catalog: EmitCatalog,
    targetEvents: Record<string, CatalogEvent>,
    result: PushResult,
  ): Promise<PushResult> {
    const multiEventTable = this.config.multi_event_table;
    const eventColumn = this.config.event_column;
    const propertiesColumn = this.config.properties_column;

    if (!multiEventTable || !eventColumn) {
      result.errors.push(
        "multi_event_table and event_column are required for schema_type: multi_event",
      );
      return result;
    }

    const { datasetPrefix, table: tableName } = splitQualified(multiEventTable);
    const tableDataset = datasetPrefix ?? this.resolvedDataset;
    assertSafeIdent(tableDataset, "dataset");
    assertSafeIdent(tableName, "table name");
    const fqDisplay = `${tableDataset}.${tableName}`;

    const client = this.createClient();
    const excludeColumns = this.getExcludeColumns();

    // 1. Verify the table exists and pull its current schema.
    let current: BigQueryTableMetadata;
    try {
      current = await client.getTableMetadata(tableDataset, tableName);
    } catch (err: any) {
      // 404 / notFound surfaces as a JS Error with code 404 on the SDK side.
      if (err.code === 404 || /not found|does not exist/i.test(err.message ?? "")) {
        result.errors.push(
          `Multi-event table not found: ${fqDisplay}. ` +
            `Check the multi_event_table field in your config.`,
        );
        return result;
      }
      throw err;
    }

    const existingColumns = new Set(
      (current.schema?.fields ?? []).map((f) => f.name),
    );
    const eventColumnLower = eventColumn.toLowerCase();
    if (!existingColumns.has(eventColumnLower)) {
      result.errors.push(
        `event_column '${eventColumn}' not found on ${fqDisplay}. ` +
          `Available columns include: ${Array.from(existingColumns).slice(0, 10).join(", ")}...`,
      );
      return result;
    }
    assertSafeIdent(eventColumnLower, "event_column");

    // 2. Build the rolled-up event summary for table + event column.
    const eventList = Object.entries(targetEvents).map(([name, ev]) => ({
      label: name,
      description: ev.description,
      firesWhen: ev.fires_when,
    }));
    const summary = "Contains events:\n" + formatEventList(eventList, { includeFiresWhen: true });

    // 3. Compute per-column description map.
    // First-write-wins for shared property columns (the earlier event in
    // targetEvents order wins when multiple events list the same property).
    const colDescriptions = new Map<string, string>();
    colDescriptions.set(eventColumnLower, summary);

    const propertyDefinitions = catalog.property_definitions ?? {};
    for (const [eventName, event] of Object.entries(targetEvents)) {
      for (const [propName, propMeta] of Object.entries(event.properties ?? {})) {
        const columnName = propToColumn(propName);
        if (excludeColumns.has(columnName)) continue;
        if (!existingColumns.has(columnName)) continue;
        if (colDescriptions.has(columnName)) continue; // first-write-wins
        colDescriptions.set(
          columnName,
          this.effectivePropertyDescription(
            propName,
            eventName,
            propMeta.description,
            propertyDefinitions,
            eventColumnLower,
          ),
        );
      }
    }

    // 4. Generic pointer on the properties column if configured and present.
    if (propertiesColumn) {
      const propertiesColumnLower = propertiesColumn.toLowerCase();
      if (existingColumns.has(propertiesColumnLower)) {
        assertSafeIdent(propertiesColumnLower, "properties_column");
        // Don't overwrite if somehow already set via a property of that name.
        if (!colDescriptions.has(propertiesColumnLower)) {
          colDescriptions.set(
            propertiesColumnLower,
            "Event-specific properties as JSON. Per-event property descriptions " +
              "are maintained in the emit catalog (see emit.catalog.yml).",
          );
        }
      }
    }

    // 5. Merge descriptions into the existing schema and write once.
    const newFields: BigQueryField[] = (current.schema?.fields ?? []).map((f) => {
      const desc = colDescriptions.get(f.name);
      if (desc === undefined) return f;
      return { ...f, description: desc };
    });

    try {
      await client.setTableMetadata(tableDataset, tableName, {
        description: summary,
        schema: { fields: newFields },
      });
      result.pushed = Object.keys(targetEvents).length;
    } catch (err: any) {
      result.errors.push(`${fqDisplay}: ${err.message}`);
    }

    return result;
  }

  /**
   * Effective description for a property column in multi-event mode —
   * consensus from property_definitions when the property is shared across
   * events; otherwise the single-event description with an attribution note.
   */
  private effectivePropertyDescription(
    propName: string,
    eventName: string,
    propDescription: string,
    propertyDefinitions: Record<string, PropertyDefinition>,
    eventColumnLower: string,
  ): string {
    const def = propertyDefinitions[propName];
    if (def && def.events && def.events.length > 1) {
      const eventList = def.events.join(", ");
      return `${def.description} Populated for events: ${eventList}.`;
    }
    return `${propDescription} Populated when ${eventColumnLower}='${eventName}'.`;
  }
}
