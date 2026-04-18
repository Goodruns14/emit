// Adapter that throws in its constructor — e.g. missing env var.
export default class ThrowingAdapter {
  name = "Throwing";
  constructor() {
    throw new Error("Missing REQUIRED_ENV_VAR");
  }
  async push() {
    return { pushed: 0, skipped: 0, skipped_events: [], errors: [] };
  }
}
