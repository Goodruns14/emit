#!/usr/bin/env bash
#
# Seed pub/sub fixture repos into the shared fixtures home so anyone can
# reproduce the producer-mode harness (scripts/e2e-pubsub-harness.ts).
#
# Fixtures live under ~/emit-fixtures/test-repos/pubsub/<name>/ and survive
# worktree teardown. The main checkout and each worktree should symlink
# test-repos/ to ~/emit-fixtures/test-repos/.
#
# Idempotent: skips fixtures that are already cloned. Use --force to re-clone.
#
# Usage:
#   bash scripts/seed-pubsub-fixtures.sh            # clone missing fixtures
#   bash scripts/seed-pubsub-fixtures.sh --force    # remove + re-clone all

set -euo pipefail

FIXTURES_ROOT="${EMIT_FIXTURES_ROOT:-$HOME/emit-fixtures/test-repos/pubsub}"
FORCE="${1:-}"

mkdir -p "$FIXTURES_ROOT"

# (name, upstream, depth=1 default)
# CONFIRMED upstreams — verified to clone cleanly and produce catalogs:
FIXTURES_CONFIRMED=(
  "golevelup-nestjs|https://github.com/golevelup/nestjs.git"
  "aws-serverless-patterns|https://github.com/aws-samples/serverless-patterns.git"
  "rabbitmq-tutorials|https://github.com/rabbitmq/rabbitmq-tutorials.git"
  "learn-kafka-courses|https://github.com/confluentinc/learn-kafka-courses.git"
)

# TODO: fill in upstreams for tier-2 fixtures (CQRS + Avro schema-files).
FIXTURES_TODO=(
  "aleks-cqrs-eventsourcing|TODO: CQRS + event sourcing example"
  "ably-ticket-kafka|TODO: Ably ticket-kafka tutorial"
)

clone_fixture() {
  local name="$1"
  local url="$2"
  local target="$FIXTURES_ROOT/$name"

  if [[ "$url" == TODO* ]]; then
    echo "  [skip] $name — $url"
    return 0
  fi

  if [[ -d "$target/.git" ]]; then
    if [[ "$FORCE" == "--force" ]]; then
      echo "  [re-clone] $name"
      rm -rf "$target"
    else
      echo "  [exists] $name"
      return 0
    fi
  fi

  echo "  [clone] $name <- $url"
  git clone --depth 1 "$url" "$target" >/dev/null 2>&1
}

echo "Seeding pub/sub fixtures into $FIXTURES_ROOT"
echo ""
echo "Confirmed fixtures:"
for entry in "${FIXTURES_CONFIRMED[@]}"; do
  IFS='|' read -r name url <<< "$entry"
  clone_fixture "$name" "$url"
done

echo ""
echo "TODO fixtures (fill in upstream URLs above):"
for entry in "${FIXTURES_TODO[@]}"; do
  IFS='|' read -r name url <<< "$entry"
  clone_fixture "$name" "$url"
done

echo ""
echo "Done. Next steps:"
echo "  1. Drop emit.config.yml into each fixture root (mode: producer)"
echo "  2. Run: npx tsx scripts/e2e-pubsub-harness.ts"
