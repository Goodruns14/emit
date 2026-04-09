import type {
  DestinationAdapter,
  EmitCatalog,
  PushOpts,
  PushResult,
  AmplitudeDestinationConfig,
} from "../../types/index.js";

export class AmplitudeDestinationAdapter implements DestinationAdapter {
  name = "Amplitude";
  private config: AmplitudeDestinationConfig;
  private apiKey: string;
  private secretKey: string;

  constructor(config: AmplitudeDestinationConfig) {
    this.config = config;
    this.apiKey = process.env.AMPLITUDE_API_KEY ?? "";
    this.secretKey = process.env.AMPLITUDE_SECRET_KEY ?? "";
    if (!this.apiKey || !this.secretKey) {
      throw new Error(
        "Missing required environment variables: AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY\n" +
          "  Find these in your Amplitude project settings."
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

    const auth = Buffer.from(`${this.apiKey}:${this.secretKey}`).toString("base64");
    const headers = {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    };
    const base = "https://amplitude.com/api/2";

    for (const [eventName, event] of Object.entries(targetEvents)) {
      try {
        // Update event description
        const eventResp = await fetch(`${base}/taxonomy/event`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            event_type: eventName,
            description: event.description,
          }),
        });

        // 200 = created, 409 = already exists -> use PUT to update
        if (eventResp.status === 409) {
          await fetch(`${base}/taxonomy/event/${encodeURIComponent(eventName)}`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ description: event.description }),
          });
        } else if (!eventResp.ok) {
          const body = await eventResp.text().catch(() => "");
          result.errors.push(
            `${eventName}: Amplitude error ${eventResp.status} — ${body.slice(0, 100)}`
          );
          continue;
        }

        // Update property descriptions
        for (const [propName, propMeta] of Object.entries(event.properties ?? {})) {
          await fetch(`${base}/taxonomy/event-property`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              event_type: eventName,
              event_property: propName,
              description: propMeta.description,
            }),
          }).catch(() => {
            // Property update failures are non-fatal
          });
        }

        result.pushed++;
      } catch (err: any) {
        result.errors.push(`${eventName}: ${err.message}`);
      }
    }

    result.skipped = Object.keys(targetEvents).length - result.pushed - result.errors.length;
    return result;
  }
}
