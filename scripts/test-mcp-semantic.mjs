#!/usr/bin/env node
/**
 * MCP Semantic Layer Test Runner
 *
 * Simulates realistic analytics agent workflows against real catalogs.
 * Tests all 3 tiers:
 *   Tier 1 — real-catalog correctness (each tool against real data)
 *   Tier 2 — multi-tool chain workflows (agent question simulations)
 *   Tier 3 — semantic quality spot checks (human-readable output for review)
 *
 * Usage:
 *   node scripts/test-mcp-semantic.mjs
 *   node scripts/test-mcp-semantic.mjs --catalog papermark
 *   node scripts/test-mcp-semantic.mjs --tier 2
 *   node scripts/test-mcp-semantic.mjs --verbose
 */

import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ── Parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose") || args.includes("-v");
const TIER_FILTER = (() => {
  const i = args.indexOf("--tier");
  return i !== -1 ? parseInt(args[i + 1]) : null;
})();
const CATALOG_FILTER = (() => {
  const i = args.indexOf("--catalog");
  return i !== -1 ? args[i + 1] : null;
})();

// ── Dynamic import of built tools ────────────────────────────────────────────

const dist = `${ROOT}/dist`;
const { getEventTool } = await import(`${dist}/mcp/tools/get-event.js`);
const { getPropertyTool } = await import(`${dist}/mcp/tools/get-property.js`);
const { listEventsTool } = await import(`${dist}/mcp/tools/list-events.js`);
const { searchEventsTool } = await import(`${dist}/mcp/tools/search-events.js`);
const { listNotFoundTool } = await import(`${dist}/mcp/tools/list-not-found.js`);
const { getCatalogHealthTool } = await import(`${dist}/mcp/tools/get-catalog-health.js`);
const { getPropertyAcrossEventsTool } = await import(`${dist}/mcp/tools/get-property-across-events.js`);
const { listPropertiesTool } = await import(`${dist}/mcp/tools/list-properties.js`);
const { getEventsBySourceFileTool } = await import(`${dist}/mcp/tools/get-events-by-source-file.js`);

// ── Catalog registry ─────────────────────────────────────────────────────────

const CATALOGS = {
  papermark: `${ROOT}/test-repos/papermark/emit.catalog.yml`,
  infisical: `${ROOT}/test-repos/infisical/emit.catalog.yml`,
  formbricks: `${ROOT}/test-repos/formbricks/emit.catalog.yml`,
  novu: `${ROOT}/test-repos/novu/emit.catalog.yml`,
};

// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function parse(result) {
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return null;
  }
}

function assert(label, condition, details = "") {
  if (condition) {
    passed++;
    if (VERBOSE) console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push({ label, details });
    console.log(`  ✗ ${label}${details ? ` — ${details}` : ""}`);
  }
}

function section(title, tier) {
  if (TIER_FILTER !== null && TIER_FILTER !== tier) return false;
  console.log(`\n${"─".repeat(60)}`);
  console.log(`[Tier ${tier}] ${title}`);
  console.log("─".repeat(60));
  return true;
}

function show(label, data) {
  console.log(`\n  ► ${label}`);
  console.log(JSON.stringify(data, null, 2).split("\n").map(l => `    ${l}`).join("\n"));
}

// ── TIER 1: Real-catalog correctness ─────────────────────────────────────────

if (section("Real-catalog correctness — papermark", 1) && (!CATALOG_FILTER || CATALOG_FILTER === "papermark")) {
  const cat = CATALOGS.papermark;

  // list_events
  const allEvents = parse(listEventsTool(cat, {}));
  assert("list_events returns all 23 papermark events", allEvents?.count === 23, `got ${allEvents?.count}`);

  const highConf = parse(listEventsTool(cat, { confidence: "high" }));
  assert("list_events(high) returns only high-confidence events",
    highConf?.events?.every(e => e.confidence === "high"));

  const needsReview = parse(listEventsTool(cat, { review_required: true }));
  assert("list_events(review_required) count > 0 or = 0 (valid response)", needsReview !== null);

  // search_events
  const linkSearch = parse(searchEventsTool(cat, { query: "link" }));
  const linkNames = linkSearch?.events?.map(e => e.name) ?? [];
  assert("search('link') finds Link Added", linkNames.includes("Link Added"), `got: ${linkNames.join(", ")}`);
  assert("search('link') finds Link Viewed", linkNames.includes("Link Viewed"), `got: ${linkNames.join(", ")}`);
  assert("search('link') finds Link Updated", linkNames.includes("Link Updated"));

  const docSearch = parse(searchEventsTool(cat, { query: "document" }));
  assert("search('document') finds Document Added", docSearch?.events?.some(e => e.name === "Document Added"));

  // get_event
  const linkViewed = parse(getEventTool(cat, { event_name: "Link Viewed" }));
  assert("get_event('Link Viewed') returns description", !!linkViewed?.description);
  assert("get_event('Link Viewed') returns fires_when", !!linkViewed?.fires_when);
  assert("get_event('Link Viewed') has properties", Object.keys(linkViewed?.properties ?? {}).length > 0);
  assert("get_event('Link Viewed') has teamId property", !!linkViewed?.properties?.teamId);
  assert("get_event('Link Viewed') has source_file", !!linkViewed?.source_file);

  const bogus = getEventTool(cat, { event_name: "nonexistent_event_xyz" });
  assert("get_event(unknown) returns isError=true", bogus.isError === true);

  // get_property
  const teamIdProp = parse(getPropertyTool(cat, { event_name: "Link Viewed", property_name: "teamId" }));
  assert("get_property('Link Viewed', 'teamId') returns description", !!teamIdProp?.description);
  assert("get_property has canonical_definition (teamId is a shared prop)", !!teamIdProp?.canonical_definition);

  const docIdProp = parse(getPropertyTool(cat, { event_name: "Link Viewed", property_name: "documentId" }));
  assert("get_property('Link Viewed', 'documentId') returns description", !!docIdProp?.description);

  // get_property_across_events
  const teamIdCross = parse(getPropertyAcrossEventsTool(cat, { property_name: "teamId" }));
  assert("get_property_across_events('teamId') appears in 10+ events", (teamIdCross?.event_count ?? 0) >= 10,
    `got ${teamIdCross?.event_count}`);
  assert("get_property_across_events('teamId') has canonical_definition", !!teamIdCross?.canonical_definition);
  assert("get_property_across_events('teamId') occurrences have per-event descriptions",
    teamIdCross?.occurrences?.every(o => !!o.description));

  // list_properties
  const props = parse(listPropertiesTool(cat, {}));
  assert("list_properties returns teamId and documentId",
    props?.properties?.some(p => p.name === "teamId") && props?.properties?.some(p => p.name === "documentId"));
  assert("list_properties sorted by event_count descending",
    props?.properties?.[0]?.event_count >= props?.properties?.[1]?.event_count);

  const filteredProps = parse(listPropertiesTool(cat, { min_events: 5 }));
  assert("list_properties(min_events=5) only returns high-use properties",
    filteredProps?.properties?.every(p => p.event_count >= 5));

  // get_events_by_source_file
  const sourceResults = parse(getEventsBySourceFileTool(cat, { file_path: "checkout" }));
  assert("get_events_by_source_file('checkout') returns valid response (0 or more)", sourceResults !== null);

  // catalog health
  const health = parse(getCatalogHealthTool(cat));
  assert("get_catalog_health returns total_events=23", health?.total_events === 23, `got ${health?.total_events}`);
  assert("get_catalog_health has confidence breakdown", health?.high_confidence !== undefined);

  // not_found
  const notFound = parse(listNotFoundTool(cat));
  assert("list_not_found returns valid response", notFound !== null);
  assert("list_not_found count is 0 (all events found)", notFound?.count === 0, `got ${notFound?.count}`);
}

if (section("Real-catalog correctness — infisical (discriminators + security domain)", 1) && (!CATALOG_FILTER || CATALOG_FILTER === "infisical")) {
  const cat = CATALOGS.infisical;

  const allEvents = parse(listEventsTool(cat, {}));
  assert("list_events returns events from infisical catalog", (allEvents?.count ?? 0) > 0, `got ${allEvents?.count}`);

  // infisical has discriminator sub-events like "Integration Synced.aws-parameter-store"
  const subEvent = parse(getEventTool(cat, { event_name: "Integration Synced.aws-parameter-store" }));
  assert("get_event works for discriminator sub-event", !subEvent?.error || subEvent?.description !== undefined);

  const secretsPushed = parse(getEventTool(cat, { event_name: "secrets pushed" }));
  assert("get_event('secrets pushed') returns description", !!secretsPushed?.description);
  // Note: secrets pushed has 0 properties in catalog — scan gap, event fires as an onboarding signal only

  // Use Integration Created (17 props) for property tests
  const integrationCreated = parse(getEventTool(cat, { event_name: "Integration Created" }));
  assert("get_event('Integration Created') has properties", Object.keys(integrationCreated?.properties ?? {}).length > 0);

  const envProp = parse(getPropertyTool(cat, { event_name: "Integration Created", property_name: "environment" }));
  assert("get_property('environment') on Integration Created returns description", !!envProp?.description);

  const envCross = parse(getPropertyAcrossEventsTool(cat, { property_name: "environment" }));
  assert("environment property appears across multiple events", (envCross?.event_count ?? 0) > 1,
    `appeared in ${envCross?.event_count}`);

  const secretSearch = parse(searchEventsTool(cat, { query: "secret" }));
  assert("search('secret') returns multiple events", (secretSearch?.count ?? 0) >= 3,
    `got ${secretSearch?.count}`);

  const authSearch = parse(searchEventsTool(cat, { query: "auth" }));
  assert("search('auth') finds relevant events", (authSearch?.count ?? 0) >= 1);
}

// ── TIER 2: Agent workflow simulations ───────────────────────────────────────

if (section("Agent workflow: 'I want to chart document shares by team — what event and property?'", 2)) {
  const cat = CATALOGS.papermark;

  // Step 1: discover events
  const step1 = parse(searchEventsTool(cat, { query: "document share link" }));
  assert("Step 1: search returns relevant events", (step1?.count ?? 0) > 0);
  if (VERBOSE) show("Step 1 — search('document share link')", { count: step1?.count, events: step1?.events?.map(e => ({ name: e.name, matched_on: e.matched_on })) });

  // Step 2: get full event definition for a candidate
  const step2 = parse(getEventTool(cat, { event_name: "Link Viewed" }));
  assert("Step 2: get_event returns actionable description", !!step2?.description);
  assert("Step 2: fires_when tells agent when it triggers", !!step2?.fires_when);
  assert("Step 2: has teamId for the 'by team' breakdown", !!step2?.properties?.teamId);
  if (VERBOSE) show("Step 2 — get_event('Link Viewed')", { description: step2?.description, fires_when: step2?.fires_when, property_names: Object.keys(step2?.properties ?? {}) });

  // Step 3: check the property they'd use for grouping
  const step3 = parse(getPropertyTool(cat, { event_name: "Link Viewed", property_name: "teamId" }));
  assert("Step 3: teamId property has description", !!step3?.description);
  assert("Step 3: teamId has cardinality info", step3?.cardinality !== undefined);
  assert("Step 3: canonical_definition present (agent knows this is a shared concept)", !!step3?.canonical_definition);
  if (VERBOSE) show("Step 3 — get_property('Link Viewed', 'teamId')", step3);

  console.log(`\n  ✦ Agent can answer: use 'Link Viewed' event, break down by 'teamId' (cardinality: ${step3?.cardinality})`);
}

if (section("Agent workflow: 'Is user_id consistent or does it mean different things across events?'", 2)) {
  const cat = CATALOGS.papermark;

  const result = parse(getPropertyAcrossEventsTool(cat, { property_name: "viewerEmail" }));
  assert("get_property_across_events returns occurrences list", Array.isArray(result?.occurrences));
  assert("each occurrence has event_name + description", result?.occurrences?.every(o => o.event_name && o.description));

  if (VERBOSE) show("viewerEmail across events", {
    event_count: result?.event_count,
    canonical: result?.canonical_definition,
    events: result?.occurrences?.map(o => ({ event: o.event_name, description: o.description }))
  });

  // If there's a canonical definition, agent should flag it
  if (result?.canonical_definition) {
    console.log(`\n  ✦ Agent can answer: viewerEmail has a canonical definition — consistent usage`);
  } else {
    console.log(`\n  ✦ Agent should warn: no canonical definition — check per-event descriptions for drift`);
  }
}

if (section("Agent workflow: 'Which events should I avoid in my retention analysis — are any unreliable?'", 2)) {
  const cat = CATALOGS.papermark;

  const lowConf = parse(listEventsTool(cat, { confidence: "low" }));
  const needsReview = parse(listEventsTool(cat, { review_required: true }));

  assert("list_events(low) returns valid list", Array.isArray(lowConf?.events));
  assert("list_events(review_required) returns valid list", Array.isArray(needsReview?.events));

  if (VERBOSE) {
    show("Low confidence events", { count: lowConf?.count, events: lowConf?.events?.map(e => e.name) });
    show("Needs review", { count: needsReview?.count, events: needsReview?.events?.map(e => e.name) });
  }

  // Get detail on any flagged event
  if (lowConf?.events?.length > 0) {
    const flagged = parse(getEventTool(cat, { event_name: lowConf.events[0].name }));
    assert("flagged event has confidence_reason explaining why", !!flagged?.confidence_reason);
    assert("flagged event has flags array", Array.isArray(flagged?.flags));
    if (VERBOSE) show(`Flagged event detail — ${lowConf.events[0].name}`, {
      confidence: flagged?.confidence,
      confidence_reason: flagged?.confidence_reason,
      flags: flagged?.flags
    });
    console.log(`\n  ✦ Agent can answer: avoid '${lowConf.events[0].name}' — ${flagged?.confidence_reason}`);
  } else {
    console.log(`\n  ✦ Agent can answer: all events are high confidence in this catalog`);
  }
}

if (section("Agent workflow: 'What analytics does the subscription/billing feature track?'", 2)) {
  const cat = CATALOGS.papermark;

  const search = parse(searchEventsTool(cat, { query: "subscription billing upgrade" }));
  const searchNames = search?.events?.map(e => e.name) ?? [];
  assert("search finds Subscription Cancelled", searchNames.includes("Subscription Cancelled"),
    `got: ${searchNames.join(", ")}`);
  assert("search finds Upgrade Button Clicked", searchNames.includes("Upgrade Button Clicked"),
    `got: ${searchNames.join(", ")}`);

  // Ranking: strongly-matching events (name + description hits) should rank above
  // tangential ones (e.g. Folder Added matches 'upgrade' only via a code_sample_value).
  const folderIdx = searchNames.indexOf("Folder Added");
  const subIdx = searchNames.indexOf("Subscription Cancelled");
  const upgIdx = searchNames.indexOf("Upgrade Button Clicked");
  if (folderIdx !== -1) {
    assert("ranking: Subscription Cancelled ranks above Folder Added", subIdx < folderIdx,
      `Subscription Cancelled at ${subIdx}, Folder Added at ${folderIdx}`);
    assert("ranking: Upgrade Button Clicked ranks above Folder Added", upgIdx < folderIdx,
      `Upgrade Button Clicked at ${upgIdx}, Folder Added at ${folderIdx}`);
  }
  assert("each result has relevance_score", search?.events?.every(e => typeof e.relevance_score === "number"));

  if (VERBOSE) show("search('subscription billing upgrade')", {
    count: search?.count,
    events: search?.events?.map(e => ({ name: e.name, score: e.relevance_score, matched_on: e.matched_on, matched_properties: e.matched_properties }))
  });

  const relevantCount = searchNames.filter(n => ["Subscription Cancelled", "Upgrade Button Clicked"].includes(n)).length;
  console.log(`\n  ✦ Found ${relevantCount}/2 directly relevant events, ranked above tangential matches`);
}

if (section("Agent workflow: 'I see Integration Synced in Amplitude — what does it actually track? Is it one event or many?'", 2)) {
  const cat = CATALOGS.infisical;

  // Search for it
  const search = parse(searchEventsTool(cat, { query: "Integration Synced" }));
  assert("search finds Integration Synced + sub-events", (search?.count ?? 0) >= 1);
  if (VERBOSE) show("search('Integration Synced')", { count: search?.count, events: search?.events?.map(e => e.name) });

  // Get parent event
  const parent = parse(getEventTool(cat, { event_name: "Integration Synced" }));
  assert("parent Integration Synced has description", !!parent?.description);

  // Try a sub-event
  const subNames = search?.events?.map(e => e.name).filter(n => n.includes(".")) ?? [];
  if (subNames.length > 0) {
    const sub = parse(getEventTool(cat, { event_name: subNames[0] }));
    assert(`sub-event '${subNames[0]}' is accessible via get_event`, !!sub?.description);
    if (VERBOSE) show(`Sub-event: ${subNames[0]}`, { description: sub?.description, parent_event: sub?.parent_event });
    console.log(`\n  ✦ Agent can answer: 'Integration Synced' is a god event with ${subNames.length} sub-events (e.g. ${subNames[0]})`);
  }
}

if (section("Agent workflow: 'What properties can I use to filter the Integration Created event in Snowflake?'", 2)) {
  const cat = CATALOGS.infisical;

  const event = parse(getEventTool(cat, { event_name: "Integration Created" }));
  assert("Integration Created event exists", !!event?.description);

  const propNames = Object.keys(event?.properties ?? {});
  assert("Integration Created has filterable properties", propNames.length > 0, `found: ${propNames.join(", ")}`);

  if (VERBOSE) show("Integration Created properties", {
    event: "Integration Created",
    properties: Object.entries(event?.properties ?? {}).map(([name, p]) => ({
      name,
      description: p.description,
      cardinality: p.cardinality,
      sample_values: p.sample_values
    }))
  });

  // Drill into a specific property the agent might ask about
  if (propNames.includes("environment")) {
    const envDetail = parse(getPropertyTool(cat, { event_name: "Integration Created", property_name: "environment" }));
    assert("environment property has description + sample values", !!envDetail?.description && Array.isArray(envDetail?.sample_values));
    if (VERBOSE) show("environment property detail", envDetail);
    const sampleStr = envDetail?.sample_values?.length ? envDetail.sample_values.join(", ") : "(no samples — check edge_cases)";
    console.log(`\n  ✦ Agent can answer: filter by 'environment' (${sampleStr}), 'integration', 'app', etc.`);
  }
}

if (section("Agent workflow: 'I want to find all events that fire in the onboarding flow'", 2)) {
  const cat = CATALOGS.papermark;

  // Approach A: search by concept
  const conceptSearch = parse(searchEventsTool(cat, { query: "signup account created onboarding" }));
  assert("search('signup account created onboarding') returns results", (conceptSearch?.count ?? 0) > 0);
  if (VERBOSE) show("search results", { count: conceptSearch?.count, events: conceptSearch?.events?.map(e => e.name) });

  // Approach B: by source file (if we knew the file)
  const fileSearch = parse(getEventsBySourceFileTool(cat, { file_path: "auth" }));
  assert("get_events_by_source_file('auth') returns valid response", fileSearch !== null);
  if (VERBOSE && fileSearch?.count > 0) show("Events in auth files", { count: fileSearch?.count, events: fileSearch?.events?.map(e => e.name) });

  console.log(`\n  ✦ Agent strategy: combine search-by-concept (${conceptSearch?.count} hits) + search-by-file for coverage`);
}

// ── TIER 3: Semantic quality spot checks ─────────────────────────────────────

if (section("Semantic quality: descriptions are useful for query-building (human review)", 3)) {
  const cat = CATALOGS.papermark;

  console.log("\n  These require human review — checking min quality signals:\n");

  const events = ["Link Viewed", "Document Added", "Subscription Cancelled", "Team Member Invitation Sent"];
  for (const name of events) {
    const e = parse(getEventTool(cat, { event_name: name }));
    if (!e) { console.log(`  ? ${name} — not found`); continue; }

    const hasUsefulDesc = e.description?.length > 20;
    const hasFiresWhen = !!e.fires_when;
    const propCount = Object.keys(e.properties ?? {}).length;
    const hasSampleValues = Object.values(e.properties ?? {}).some(p => p.sample_values?.length > 0);

    assert(`'${name}' has actionable description (>20 chars)`, hasUsefulDesc, `"${e.description}"`);
    assert(`'${name}' has fires_when`, hasFiresWhen, `got: ${e.fires_when}`);
    assert(`'${name}' has at least 1 property`, propCount > 0, `got ${propCount}`);

    if (VERBOSE) {
      console.log(`\n    Event: ${name}`);
      console.log(`    Description: ${e.description}`);
      console.log(`    Fires when: ${e.fires_when}`);
      console.log(`    Properties: ${Object.keys(e.properties ?? {}).join(", ")}`);
      console.log(`    Sample values present: ${hasSampleValues}`);
    }
  }
}

if (section("Semantic quality: property deviations surface correctly for cross-event props", 3)) {
  const cat = CATALOGS.papermark;

  const teamId = parse(getPropertyAcrossEventsTool(cat, { property_name: "teamId" }));
  assert("teamId canonical_definition is present", !!teamId?.canonical_definition?.description);
  assert("teamId occurrences include per-event descriptions", teamId?.occurrences?.every(o => !!o.description));

  // Check that the canonical vs per-event descriptions differ (proving deviations are surfaced)
  const canonDesc = teamId?.canonical_definition?.description;
  const deviating = teamId?.occurrences?.filter(o => o.description !== canonDesc);

  if (VERBOSE) {
    console.log(`\n  Canonical: "${canonDesc}"`);
    for (const o of (teamId?.occurrences ?? [])) {
      const differs = o.description !== canonDesc;
      console.log(`  ${differs ? "≠" : "="} ${o.event_name}: "${o.description}"`);
    }
  }

  assert("some events have deviating teamId descriptions (per-event context is surfaced)",
    deviating?.length > 0, `all ${teamId?.occurrences?.length} occurrences identical to canonical`);

  console.log(`\n  ✦ ${deviating?.length} of ${teamId?.occurrences?.length} events have contextual teamId descriptions`);
}

if (section("Semantic quality: discovery completeness — does list_properties surface all usable breakdowns?", 3)) {
  const cat = CATALOGS.papermark;

  const allProps = parse(listPropertiesTool(cat, {}));
  assert("list_properties returns catalog-wide breakdown inventory", (allProps?.count ?? 0) > 0);

  const highUse = allProps?.properties?.filter(p => p.event_count >= 3) ?? [];
  assert("at least some properties appear in 3+ events", highUse.length > 0);

  if (VERBOSE) {
    console.log("\n  High-use properties (useful for global breakdowns):");
    for (const p of highUse) {
      console.log(`    ${p.name} — ${p.event_count} events${p.has_canonical_definition ? " [canonical def]" : ""}`);
    }
  }

  console.log(`\n  ✦ ${highUse.length} properties appear in 3+ events — good candidates for global filters`);
  console.log(`  ✦ ${allProps?.properties?.filter(p => p.has_canonical_definition).length} properties have canonical definitions`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n${"═".repeat(60)}`);
console.log(`Results: ${passed}/${total} passed${failed > 0 ? ` (${failed} failed)` : " ✓"}`);
if (failures.length > 0) {
  console.log("\nFailed:");
  for (const f of failures) {
    console.log(`  ✗ ${f.label}${f.details ? ` — ${f.details}` : ""}`);
  }
}
console.log(`${"═".repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
