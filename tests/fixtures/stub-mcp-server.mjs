#!/usr/bin/env node
// Tiny MCP stub server for testing emit's destination MCP delegation.
//
// Behavior: registers a single `query` tool that pretends to be a
// SQL-passthrough endpoint. It parses the SQL just enough to extract
// the property/event mentioned and returns a deterministic row set.
//
// Stdio transport, same as a real destination MCP would use.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "stub-bigquery-mcp", version: "0.0.1" });

server.tool(
  "query",
  "Fake SQL passthrough for testing",
  { sql: z.string() },
  async ({ sql }) => {
    // Special: a SQL containing "FAIL_TEST" forces a tool error
    if (sql.includes("FAIL_TEST")) {
      return {
        content: [{ type: "text", text: "simulated query failure" }],
        isError: true,
      };
    }

    // Special: a SQL containing "RETURN_TEXT" forces a non-JSON text response
    if (sql.includes("RETURN_TEXT")) {
      return {
        content: [{ type: "text", text: "this is not JSON" }],
      };
    }

    // Special: a SQL containing "RETURN_WRAPPED" returns rows under a "rows" key
    if (sql.includes("RETURN_WRAPPED")) {
      const m = sql.match(/SELECT DISTINCT (\w+)/i);
      const col = m ? m[1] : "value";
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              rows: [
                { [col]: "wrapped_a" },
                { [col]: "wrapped_b" },
              ],
            }),
          },
        ],
      };
    }

    // Default: parse "SELECT DISTINCT <col> FROM <table>" and return canned values
    const m = sql.match(/SELECT DISTINCT (\w+) FROM (\w+)/i);
    const col = m ? m[1] : "value";
    const table = m ? m[2] : "unknown";
    const rows = [
      { [col]: `${table}__alpha` },
      { [col]: `${table}__beta` },
      { [col]: `${table}__gamma` },
    ];
    return {
      content: [{ type: "text", text: JSON.stringify(rows) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
