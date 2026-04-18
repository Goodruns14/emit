// Uses a named `Adapter` export instead of default — the loader should accept this.
export class Adapter {
  name = "NamedExport";
  constructor(_options) {}
  async push(_catalog, _opts) {
    return { pushed: 0, skipped: 0, skipped_events: [], errors: [] };
  }
}
