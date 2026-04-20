import type { Command } from "commander";
import { runDestinationAdd } from "./destination/add.js";
import { runDestinationList } from "./destination/list.js";
import { runDestinationTest } from "./destination/test.js";
import { runDestinationRemove } from "./destination/remove.js";

export function registerDestination(program: Command): void {
  const dest = program
    .command("destination")
    .description(
      "Manage custom destination adapters (git-remote-style: add/list/test/remove)",
    );

  dest
    .command("add [name]")
    .description("Scaffold a new custom destination adapter and append it to emit.config.yml")
    .action(async (name?: string) => {
      const code = await runDestinationAdd(name);
      process.exit(code);
    });

  dest
    .command("list")
    .description("List configured destinations and whether their adapter files are present")
    .option("--format <format>", "Output format: text (default) or json")
    .action(async (opts: { format?: string }) => {
      const code = await runDestinationList(opts);
      process.exit(code);
    });

  dest
    .command("test <name>")
    .description("Fire a single-event push to a destination with --verbose (authoring iteration loop)")
    .option("--event <name>", "Override the catalog event used for the test (defaults to the first event)")
    .action(async (name: string, opts: { event?: string }) => {
      const code = await runDestinationTest(name, opts);
      process.exit(code);
    });

  dest
    .command("remove <name>")
    .description("Remove a destination from emit.config.yml (leaves the adapter .mjs file untouched)")
    .action(async (name: string) => {
      const code = await runDestinationRemove(name);
      process.exit(code);
    });
}
