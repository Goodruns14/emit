#!/usr/bin/env node
import { Command } from "commander";
import { registerScan } from "./commands/scan.js";
import { registerInit } from "./commands/init.js";
import { registerStatus } from "./commands/status.js";
import { registerRevert } from "./commands/revert.js";
import { registerPush } from "./commands/push.js";
import pkg from "../package.json";

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

program.parse(process.argv);
