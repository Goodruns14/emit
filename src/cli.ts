#!/usr/bin/env node
import { Command } from "commander";
import { registerScan } from "./commands/scan.js";
import { registerInit } from "./commands/init.js";
import { registerStatus } from "./commands/status.js";
import { registerRevert } from "./commands/revert.js";
import { registerPush } from "./commands/push.js";
import { registerImport } from "./commands/import.js";
import { registerMcp } from "./commands/mcp.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const program = new Command();

program
  .name("emit")
  .description(pkg.description)
  .version(pkg.version, "-v, --version", "Print version number");

registerInit(program);
registerScan(program);
registerStatus(program);
registerRevert(program);
registerPush(program);
registerImport(program);
registerMcp(program);

program.parse(process.argv);
