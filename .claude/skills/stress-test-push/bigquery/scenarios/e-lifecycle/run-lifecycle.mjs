/**
 * E1-E6 lifecycle:
 *   E1: Initial push — "V1" description lands on BigQuery
 *   E2: Edit local catalog description → "V2"
 *   E3: Re-push → BigQuery shows V2 (overwrite, not append)
 *   E4: Revert local catalog back to V1 (simulated git revert)
 *   E5: Re-push → BigQuery shows V1 again (roll-back via idempotence)
 *   E6: Push 3 times consecutively — result stable (idempotent, no accumulation)
 */
import { connect, getColumnDescriptions, Checks } from "../_shared.mjs";
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MASTER_PATH = resolve(__dirname, "../../master-catalog.yml");
// Runtime copy under .emit/ — gitignored globally, so the tree stays clean
// between runs even though this scenario edits the catalog in place.
const CATALOG_PATH = resolve(__dirname, ".emit/catalog.yml");
const EMIT_CLI = "/Users/charliefitz/Desktop/Emit/dist/cli.js";

mkdirSync(dirname(CATALOG_PATH), { recursive: true });
copyFileSync(MASTER_PATH, CATALOG_PATH);

const V1 = "STRESS-TEST: V1 LIFECYCLE-MARKER — Total transaction amount.";
const V2 = "STRESS-TEST: V2 LIFECYCLE-MARKER — revised description.";

function setBillAmountDescription(text) {
  const yml = readFileSync(CATALOG_PATH, "utf8");
  // Only touch bill_amount under purchase_completed
  const updated = yml.replace(
    /bill_amount:\n        description: "STRESS-TEST: [^"]+"/,
    `bill_amount:\n        description: "${text}"`,
  );
  writeFileSync(CATALOG_PATH, updated);
}

function push() {
  return execSync(
    `cd "${__dirname}" && node ${EMIT_CLI} push --destination bigquery 2>&1`,
    { encoding: "utf8" },
  );
}

const bq = connect();
const checks = new Checks("E — lifecycle: push → edit → re-push → revert → re-push");

// E1
console.log("\n[E1] Initial push (V1)");
setBillAmountDescription(V1);
push();
const e1 = await getColumnDescriptions(bq, "emit_stress_custom", "evt_purchase_completed");
checks.expect(
  "E1: bill_amount has V1 description",
  (e1.bill_amount || "").includes("V1 LIFECYCLE-MARKER"),
);

// E2
console.log("\n[E2] Edit catalog → V2");
setBillAmountDescription(V2);
const yml = readFileSync(CATALOG_PATH, "utf8");
checks.expect(
  "E2: catalog.yml now contains V2",
  yml.includes("V2 LIFECYCLE-MARKER"),
);

// E3
console.log("\n[E3] Re-push after edit");
push();
const e3 = await getColumnDescriptions(bq, "emit_stress_custom", "evt_purchase_completed");
checks.expect(
  "E3: bill_amount overwritten with V2 (no V1 leftover)",
  (e3.bill_amount || "").includes("V2 LIFECYCLE-MARKER") &&
    !(e3.bill_amount || "").includes("V1 LIFECYCLE-MARKER"),
);

// E4
console.log("\n[E4] Revert catalog to V1");
setBillAmountDescription(V1);
const ymlRevert = readFileSync(CATALOG_PATH, "utf8");
checks.expect(
  "E4: catalog.yml reverted to V1 (V2 gone)",
  ymlRevert.includes("V1 LIFECYCLE-MARKER") && !ymlRevert.includes("V2 LIFECYCLE-MARKER"),
);

// E5
console.log("\n[E5] Re-push after revert");
push();
const e5 = await getColumnDescriptions(bq, "emit_stress_custom", "evt_purchase_completed");
checks.expect(
  "E5: bill_amount rolled back to V1 (no V2 leftover)",
  (e5.bill_amount || "").includes("V1 LIFECYCLE-MARKER") &&
    !(e5.bill_amount || "").includes("V2 LIFECYCLE-MARKER"),
);

// E6
console.log("\n[E6] Triple push (idempotence)");
push();
push();
push();
const e6 = await getColumnDescriptions(bq, "emit_stress_custom", "evt_purchase_completed");
checks.expect(
  "E6: bill_amount still V1 after 3 consecutive pushes",
  (e6.bill_amount || "").includes("V1 LIFECYCLE-MARKER"),
);
checks.expect(
  "E6: description length reasonable (no drift/accumulation)",
  (e6.bill_amount || "").length < 250,
);

process.exit(checks.summary() ? 0 : 1);
