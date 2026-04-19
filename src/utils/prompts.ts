import * as readline from "readline";
import chalk from "chalk";

// Arrow-key single select. Renders an interactive list; returns the chosen value.
export async function arrowSelect<T extends string>(
  options: { label: string; value: T }[]
): Promise<T> {
  let idx = 0;
  const count = options.length;

  const render = (first: boolean) => {
    if (!first) {
      process.stdout.write(`\u001B[${count}A`);
    }
    for (let i = 0; i < count; i++) {
      const cursor = i === idx ? chalk.cyan("❯") : " ";
      const label = i === idx ? chalk.white(options[i].label) : chalk.gray(options[i].label);
      process.stdout.write(`\r\u001B[2K  ${cursor}  ${label}\n`);
    }
  };

  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    render(true);

    const onData = (key: string) => {
      if (key === "\u001B[A") {
        idx = Math.max(0, idx - 1);
        render(false);
      } else if (key === "\u001B[B") {
        idx = Math.min(count - 1, idx + 1);
        render(false);
      } else if (key === "\r" || key === "\n") {
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve(options[idx].value);
      } else if (key === "\u0003") {
        process.exit(0);
      }
    };

    process.stdin.on("data", onData);
  });
}

export interface Prompter {
  ask(question: string): Promise<string>;
  close(): void;
}

export function createPrompter(): Prompter {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  return {
    ask(question: string): Promise<string> {
      return new Promise((resolve) => {
        rl.question(question, resolve);
      });
    },
    close() {
      rl.close();
    },
  };
}
