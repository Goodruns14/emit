// An adapter that records its constructor options — used to verify options flow through.
export default class OptionsAdapter {
  name = "Options";
  constructor(options) {
    this.receivedOptions = options;
  }
  async push(_catalog, _opts) {
    return {
      pushed: 0,
      skipped: 0,
      skipped_events: [],
      errors: [],
      // leak options into result for assertion (tests only)
      __receivedOptions: this.receivedOptions,
    };
  }
}
