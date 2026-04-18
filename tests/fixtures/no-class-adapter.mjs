// Default export is an object, not a class — should be rejected.
export default {
  name: "NotAClass",
  push: async () => ({ pushed: 0, skipped: 0, skipped_events: [], errors: [] }),
};
