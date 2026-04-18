/**
 * Mixpanel destination adapter for emit push — custom-adapter edition.
 *
 * This file is a proof-of-concept demonstrating that emit's `type: custom`
 * loader can reproduce a built-in destination against the real Mixpanel API.
 * It mirrors src/core/destinations/mixpanel.ts line-for-line but runs as a
 * user-authored adapter loaded via dynamic import.
 *
 * Usage:
 *   emit.config.yml
 *     destinations:
 *       - type: custom
 *         module: ./examples/mixpanel-adapter.mjs
 *         name: Mixpanel
 *         options:
 *           project_id: "${MIXPANEL_PROJECT_ID}"
 *
 *   env:
 *     MIXPANEL_SERVICE_ACCOUNT_USER
 *     MIXPANEL_SERVICE_ACCOUNT_SECRET
 *     MIXPANEL_PROJECT_ID
 *
 *   emit push --destination Mixpanel --dry-run
 *   emit push --destination Mixpanel --verbose --event <one_event>
 *   emit push --destination Mixpanel
 *
 * Docs: https://developer.mixpanel.com/reference/schemas
 *
 * @typedef {import('emit-catalog').DestinationAdapter} DestinationAdapter
 * @typedef {import('emit-catalog').EmitCatalog}        EmitCatalog
 * @typedef {import('emit-catalog').PushOpts}           PushOpts
 * @typedef {import('emit-catalog').PushResult}         PushResult
 */

/** @implements {DestinationAdapter} */
export default class MixpanelCustomAdapter {
  name = "Mixpanel";

  /**
   * @param {{ project_id?: string | number }} options
   */
  constructor(options = {}) {
    this.serviceAccountUser = process.env.MIXPANEL_SERVICE_ACCOUNT_USER ?? "";
    this.serviceAccountSecret = process.env.MIXPANEL_SERVICE_ACCOUNT_SECRET ?? "";
    this.projectId = String(
      process.env.MIXPANEL_PROJECT_ID ?? options.project_id ?? ""
    );

    if (!this.serviceAccountUser || !this.serviceAccountSecret) {
      throw new Error(
        "Missing required environment variables:\n" +
          "  MIXPANEL_SERVICE_ACCOUNT_USER\n" +
          "  MIXPANEL_SERVICE_ACCOUNT_SECRET\n" +
          "  Find these in Mixpanel project settings under Service Accounts."
      );
    }
    if (!this.projectId) {
      throw new Error(
        "Missing Mixpanel project ID. Set MIXPANEL_PROJECT_ID env var or provide options.project_id."
      );
    }
  }

  /**
   * @param {EmitCatalog} catalog
   * @param {PushOpts} [opts]
   * @returns {Promise<PushResult>}
   */
  async push(catalog, opts = {}) {
    /** @type {PushResult} */
    const result = { pushed: 0, skipped: 0, skipped_events: [], errors: [] };

    const events = catalog.events ?? {};
    const targetEvents = opts.events
      ? Object.fromEntries(
          Object.entries(events).filter(([name]) => opts.events.includes(name))
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
      /** @type {Record<string, { type: string; description: string }>} */
      const properties = {};
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
        result.errors.push(
          `Mixpanel API error ${resp.status}: ${body.slice(0, 200)}`
        );
        return result;
      }

      result.pushed = schemas.length;
    } catch (err) {
      result.errors.push(`Mixpanel request failed: ${err.message}`);
    }

    return result;
  }
}
