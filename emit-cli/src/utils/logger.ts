import chalk from "chalk";
import ora, { type Ora } from "ora";

let _spinner: Ora | null = null;

export const logger = {
  // ── Spinner ────────────────────────────────────────────────────────
  spin(text: string): void {
    if (_spinner) _spinner.stop();
    _spinner = ora({ text, discardStdin: false }).start();
  },

  succeed(text?: string): void {
    if (_spinner) {
      _spinner.succeed(text);
      _spinner = null;
    } else if (text) {
      process.stdout.write(chalk.green("✓ ") + text + "\n");
    }
  },

  fail(text?: string): void {
    if (_spinner) {
      _spinner.fail(text);
      _spinner = null;
    } else if (text) {
      process.stdout.write(chalk.red("✗ ") + text + "\n");
    }
  },

  stop(): void {
    if (_spinner) {
      _spinner.stop();
      _spinner = null;
    }
  },

  // ── Plain output ───────────────────────────────────────────────────
  info(text: string): void {
    if (_spinner) _spinner.stop();
    process.stdout.write(chalk.green("✓ ") + text + "\n");
    if (_spinner) _spinner.start();
  },

  warn(text: string): void {
    if (_spinner) _spinner.stop();
    process.stdout.write(chalk.yellow("⚠ ") + text + "\n");
    if (_spinner) _spinner.start();
  },

  error(text: string): void {
    if (_spinner) _spinner.stop();
    process.stderr.write(chalk.red("✗ ") + text + "\n");
  },

  line(text: string): void {
    if (_spinner) _spinner.stop();
    process.stdout.write(text + "\n");
    if (_spinner) _spinner.start();
  },

  blank(): void {
    process.stdout.write("\n");
  },

  // ── Scan-specific row output (name + result on same line) ──────────
  scanRow(name: string, result: string, status: "ok" | "warn" | "fail" | "pending"): void {
    if (_spinner) _spinner.stop();
    const icon =
      status === "ok"
        ? chalk.green("✓")
        : status === "warn"
        ? chalk.yellow("~")
        : status === "pending"
        ? chalk.blue("…")
        : chalk.red("✗");
    process.stdout.write(
      `  ${icon} ${name.padEnd(45)} ${result}\n`
    );
    if (_spinner) _spinner.start();
  },

  // ── Progress bar ───────────────────────────────────────────────────
  progress(current: number, total: number, label?: string): void {
    if (_spinner) _spinner.stop();
    const pct = Math.floor((current / total) * 24);
    const bar = "█".repeat(pct) + "░".repeat(24 - pct);
    const suffix = label ? `  ${label}` : `  ${current}/${total}`;
    process.stdout.write(`\r  ${bar}${suffix}`);
    if (current >= total) process.stdout.write("\n");
  },

  // ── Summary section ────────────────────────────────────────────────
  summary(lines: { label: string; value: string | number; warn?: boolean }[]): void {
    const maxLabel = Math.max(...lines.map((l) => l.label.length));
    for (const { label, value, warn } of lines) {
      const v = warn ? chalk.yellow(String(value)) : String(value);
      process.stdout.write(`  ${label.padEnd(maxLabel + 2)} ${v}\n`);
    }
  },
};
