/**
 * CDP presets define default table names, column names, and exclude lists
 * for common CDPs that land event data in warehouses.
 *
 * The two universal schema patterns are:
 *   monolith  — single table with a JSON properties column
 *   per_event — one table per event with flattened columns
 *
 * Every CDP uses the same two patterns; only the naming conventions differ.
 */

export interface CdpPresetConfig {
  monolith: {
    default_table: string;
    event_column: string;
    properties_column: string;
    timestamp_column: string;
  };
  per_event: {
    /** System tables to exclude when discovering event tables */
    exclude_tables: string[];
    /** System columns to exclude when listing properties */
    exclude_columns: string[];
  };
}

export const CDP_PRESETS: Record<string, CdpPresetConfig> = {
  segment: {
    monolith: {
      default_table: "ANALYTICS.TRACKS",
      event_column: "EVENT",
      properties_column: "PROPERTIES",
      timestamp_column: "RECEIVED_AT",
    },
    per_event: {
      exclude_tables: [
        "IDENTIFIES", "USERS", "PAGES", "SCREENS", "GROUPS", "ACCOUNTS",
      ],
      exclude_columns: [
        "ID", "RECEIVED_AT", "SENT_AT", "ORIGINAL_TIMESTAMP", "TIMESTAMP",
        "UUID_TS", "CONTEXT_LIBRARY_NAME", "CONTEXT_LIBRARY_VERSION",
        "ANONYMOUS_ID", "USER_ID",
      ],
    },
  },

  rudderstack: {
    monolith: {
      default_table: "TRACKS",
      event_column: "EVENT",
      properties_column: "PROPERTIES",
      timestamp_column: "RECEIVED_AT",
    },
    per_event: {
      exclude_tables: [
        "IDENTIFIES", "USERS", "PAGES", "SCREENS", "GROUPS", "RUDDER_DISCARDS",
      ],
      exclude_columns: [
        "ID", "RECEIVED_AT", "SENT_AT", "ORIGINAL_TIMESTAMP", "TIMESTAMP",
        "UUID_TS", "CONTEXT_LIBRARY_NAME", "CONTEXT_LIBRARY_VERSION",
        "ANONYMOUS_ID", "USER_ID",
      ],
    },
  },

  snowplow: {
    monolith: {
      default_table: "ATOMIC.EVENTS",
      event_column: "EVENT_NAME",
      properties_column: "UNSTRUCT_EVENT",
      timestamp_column: "COLLECTOR_TSTAMP",
    },
    per_event: {
      exclude_tables: [],
      exclude_columns: [
        "ROOT_ID", "ROOT_TSTAMP", "REF_ROOT", "REF_TREE", "REF_PARENT",
        "SCHEMA_VENDOR", "SCHEMA_NAME", "SCHEMA_FORMAT", "SCHEMA_VERSION",
      ],
    },
  },

  none: {
    monolith: {
      default_table: "EVENTS",
      event_column: "EVENT",
      properties_column: "PROPERTIES",
      timestamp_column: "CREATED_AT",
    },
    per_event: {
      exclude_tables: [],
      exclude_columns: [],
    },
  },
};
