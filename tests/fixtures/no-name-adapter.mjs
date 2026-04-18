// Instance is missing `name` string — should be rejected by the loader.
export default class NoNameAdapter {
  constructor() {}
  async push(_catalog, _opts) {
    return { pushed: 0, skipped: 0, skipped_events: [], errors: [] };
  }
}
