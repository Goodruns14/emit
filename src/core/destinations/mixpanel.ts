import type {
  DestinationAdapter,
  EmitCatalog,
  PushOpts,
  PushResult,
  MixpanelDestinationConfig,
} from "../../types/index.js";

export class MixpanelDestinationAdapter implements DestinationAdapter {
  name = "Mixpanel";
  private config: MixpanelDestinationConfig;
  private serviceAccountUser: string;
  private serviceAccountSecret: string;
  private projectId: string;

  constructor(config: MixpanelDestinationConfig) {
    this.config = config;
    this.serviceAccountUser = process.env.MIXPANEL_SERVICE_ACCOUNT_USER ?? "";
    this.serviceAccountSecret = process.env.MIXPANEL_SERVICE_ACCOUNT_SECRET ?? "";
    this.projectId = process.env.MIXPANEL_PROJECT_ID ?? String(config.project_id ?? "");

    if (!this.serviceAccountUser || !this.serviceAccountSecret) {
      throw new Error(
        "Missing required environment variables:\n" +
          "  MIXPANEL_SERVICE_ACCOUNT_USER\n" +
          "  MIXPANEL_SERVICE_ACCOUNT_SECRET\n" +
          "  Find these in your Mixpanel project settings under Service Accounts."
      );
    }
    if (!this.projectId) {
      throw new Error("Missing Mixpanel project ID. Set MIXPANEL_PROJECT_ID or destinations[].project_id.");
    }
  }

  async push(catalog: EmitCatalog, opts: PushOpts = {}): Promise<PushResult> {
    const result: PushResult = { pushed: 0, skipped: 0, errors: [] };
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

    const auth = Buffer.from(
      `${this.serviceAccountUser}:${this.serviceAccountSecret}`
    ).toString("base64");

    const schemas = Object.entries(targetEvents).map(([eventName, event]) => {
      const properties: Record<string, any> = {};
      for (const [propName, propMeta] of Object.entries(event.properties ?? {})) {
        properties[propName] = {
          type: "string",
          description: propMeta.description,
        };
      }

      return {
        entityType: "event",
        name: eventName,
        schemaJson: {
          description: event.description,
          properties,
          metadata: {
            "com.mixpanel": {
              hidden: false,
              dropped: false,
            },
          },
        },
      };
    });

    try {
      const resp = await fetch(
        `https://mixpanel.com/api/app/projects/${this.projectId}/schemas`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ entries: schemas }),
        }
      );

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        result.errors.push(`Mixpanel API error ${resp.status}: ${body.slice(0, 200)}`);
        return result;
      }

      result.pushed = schemas.length;
    } catch (err: any) {
      result.errors.push(`Mixpanel request failed: ${err.message}`);
    }

    return result;
  }
}
