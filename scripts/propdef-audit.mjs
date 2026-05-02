import * as fs from "node:fs";
import * as yaml from "js-yaml";
import * as path from "node:path";

const repos = ["papermark", "formbricks", "appsmith", "gitpod", "novu", "documenso"];
const base = "/Users/charliefitz/Desktop/Emit/test-repos";

for (const r of repos) {
  const p = path.join(base, r, "emit.catalog.yml");
  if (!fs.existsSync(p)) { console.log(`\n=== ${r}: no catalog ===`); continue; }
  const cat = yaml.load(fs.readFileSync(p, "utf8"));
  const events = Object.keys(cat.events ?? {});
  const defs = cat.property_definitions ?? {};
  const defEntries = Object.entries(defs);

  console.log(`\n=== ${r} ===`);
  console.log(`  events: ${events.length}`);
  console.log(`  property_definitions: ${defEntries.length}`);

  if (defEntries.length > 0) {
    // Sort shared props by coverage (how many events use them)
    const byCoverage = defEntries
      .map(([name, d]) => ({ name, count: (d.events ?? []).length }))
      .sort((a, b) => b.count - a.count);
    console.log(`  top shared props by coverage:`);
    for (const { name, count } of byCoverage.slice(0, 8)) {
      const pct = Math.round((count / events.length) * 100);
      console.log(`    ${name.padEnd(24)} ${count}/${events.length} events (${pct}%)`);
    }
  } else {
    console.log(`  ⚠ no shared props — every new event's proposal would be 100% "Unique"`);
  }

  // Look for props that appear on many events but DIDN'T make it to property_definitions
  // (potential "scanner missed a convention" case)
  const propCounts = {};
  for (const ev of Object.values(cat.events ?? {})) {
    for (const propName of Object.keys(ev.properties ?? {})) {
      propCounts[propName] = (propCounts[propName] ?? 0) + 1;
    }
  }
  const inDefs = new Set(defEntries.map(([n]) => n));
  const missedConventions = Object.entries(propCounts)
    .filter(([n, c]) => !inDefs.has(n) && c >= Math.max(2, events.length * 0.2))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (missedConventions.length > 0) {
    console.log(`  ⚠ props on multiple events but NOT in property_definitions (potential scanner miss):`);
    for (const [n, c] of missedConventions) {
      const pct = Math.round((c / events.length) * 100);
      console.log(`    ${n.padEnd(24)} ${c}/${events.length} events (${pct}%)`);
    }
  }
}
