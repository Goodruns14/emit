import type {
  DestinationAdapter,
  EmitCatalog,
  PushOpts,
  PushResult,
  SegmentDestinationConfig,
} from "../../types/index.js";

interface SegmentRule {
  type: string;
  key: string;
  version: number;
  schema_json: string;
}

export class SegmentDestinationAdapter implements DestinationAdapter {
  name = "Segment";
  private config: SegmentDestinationConfig;
  private token: string;

  constructor(config: SegmentDestinationConfig) {
    this.config = config;
    this.token = process.env.SEGMENT_API_TOKEN ?? "";
    if (!this.token) {
      throw new Error(
        "Missing SEGMENT_API_TOKEN environment variable.\n" +
          "  Get your token at: https://app.segment.com/goto-my-workspace/settings/access-management"
      );
    }
  }

  async push(catalog: EmitCatalog, opts: PushOpts = {}): Promise<PushResult> {
    const result: PushResult = { pushed: 0, skipped: 0, skipped_events: [], errors: [] };
    const events = catalog.events ?? {};
    const targetEvents = opts.events
      ? Object.fromEntries(
          Object.entries(events).filter(([name]) => opts.events!.includes(name))
        )
      : events;

    if (opts.dryRun) {
      result.pushed = Object.keys(targetEvents).length;
      return result;
    }

    // Fetch existing rules (throws on auth/network errors)
    let existingRules: SegmentRule[];
    try {
      existingRules = await this.fetchRules();
    } catch (err: any) {
      result.errors.push(err.message);
      return result;
    }
    const existingByKey = new Map(existingRules.map((r) => [r.key, r]));

    const rulesToUpdate: any[] = [];

    for (const [eventName, event] of Object.entries(targetEvents)) {
      const existing = existingByKey.get(eventName);
      if (!existing) {
        result.skipped++;
        continue;
      }

      const schemaJson = existing.schema_json ? JSON.parse(existing.schema_json) : {};
      schemaJson.description = event.description;

      // Update property descriptions
      if (!schemaJson.properties) schemaJson.properties = {};
      for (const [propName, propMeta] of Object.entries(event.properties ?? {})) {
        if (!schemaJson.properties[propName]) schemaJson.properties[propName] = {};
        schemaJson.properties[propName].description = propMeta.description;
      }

      rulesToUpdate.push({
        type: "TRACK",
        key: eventName,
        version: (existing.version ?? 1) + 1,
        schema_json: JSON.stringify(schemaJson),
      });
    }

    if (rulesToUpdate.length === 0) {
      result.skipped = Object.keys(targetEvents).length;
      return result;
    }

    const resp = await fetch(
      `https://api.segmentapis.com/tracking-plans/${this.config.tracking_plan_id}/rules`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ rules: rulesToUpdate }),
      }
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      result.errors.push(`Segment API error ${resp.status}: ${body.slice(0, 200)}`);
      return result;
    }

    result.pushed = rulesToUpdate.length;
    result.skipped = Object.keys(targetEvents).length - rulesToUpdate.length;
    return result;
  }

  private async fetchRules(): Promise<SegmentRule[]> {
    const resp = await fetch(
      `https://api.segmentapis.com/tracking-plans/${this.config.tracking_plan_id}/rules?pagination[count]=200`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Segment API error ${resp.status}: ${body.slice(0, 200)}`);
    }
    const data = (await resp.json()) as { data: { rules: SegmentRule[] } };
    return data?.data?.rules?.filter((r) => r.type === "TRACK") ?? [];
  }
}
