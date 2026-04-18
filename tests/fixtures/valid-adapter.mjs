export default class ValidAdapter {
  name = "Valid";
  constructor(options = {}) {
    this.options = options;
  }
  async push(catalog, opts = {}) {
    const events = catalog.events ?? {};
    const targetEvents = opts.events
      ? Object.fromEntries(Object.entries(events).filter(([n]) => opts.events.includes(n)))
      : events;
    return {
      pushed: Object.keys(targetEvents).length,
      skipped: 0,
      skipped_events: [],
      errors: [],
    };
  }
}
