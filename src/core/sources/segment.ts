import type {
  SourceAdapter,
  WarehouseEvent,
  PropertyStat,
  SegmentSourceConfig,
} from "../../types/index.js";

interface SegmentRule {
  type: string;
  key: string;
  schema?: {
    properties?: Record<string, { description?: string }>;
  };
}

interface SegmentTrackingPlanResponse {
  rules: SegmentRule[];
  next_cursor?: string;
}

export class SegmentSourceAdapter implements SourceAdapter {
  private config: SegmentSourceConfig;
  private token: string;

  constructor(config: SegmentSourceConfig) {
    this.config = config;
    this.token = process.env.SEGMENT_API_TOKEN!;
    if (!this.token) {
      throw new Error(
        "Missing SEGMENT_API_TOKEN environment variable.\n" +
          "  Get your token at: https://app.segment.com/goto-my-workspace/settings/access-management"
      );
    }
  }

  async listEvents(): Promise<WarehouseEvent[]> {
    const url =
      `https://api.segmentapis.com/tracking-plans/${this.config.tracking_plan_id}/rules` +
      `?pagination[count]=200`;

    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    });

    if (!resp.ok) {
      throw new Error(
        `Segment API error: ${resp.status} ${resp.statusText}\n` +
          `  Workspace: ${this.config.workspace}\n` +
          `  Tracking Plan: ${this.config.tracking_plan_id}`
      );
    }

    const data = (await resp.json()) as { data: SegmentTrackingPlanResponse };
    const rules = data?.data?.rules ?? [];

    return rules
      .filter((r) => r.type === "TRACK")
      .map((r) => ({
        name: r.key,
        daily_volume: 0,
        first_seen: "unknown",
        last_seen: "unknown",
      }));
  }

  async getPropertySchema(eventName: string): Promise<PropertyStat[]> {
    // Segment Protocols gives property schema definitions but not stats
    // Return empty — warehouse stats will be absent for Segment-source users
    return [];
  }
}
