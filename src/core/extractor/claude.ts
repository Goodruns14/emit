import { execFile, spawn } from "child_process";
import { promisify } from "util";
import Anthropic from "@anthropic-ai/sdk";
import type { LlmCallConfig } from "../../types/index.js";

const execFileAsync = promisify(execFile);

let _anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!_anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Missing required environment variable: ANTHROPIC_API_KEY\n" +
          "  Get your key at https://console.anthropic.com"
      );
    }
    _anthropicClient = new Anthropic({ apiKey });
  }
  return _anthropicClient;
}

let _claudeBinaryPath: string | null = null;

export async function findClaudeBinary(): Promise<string> {
  if (_claudeBinaryPath) return _claudeBinaryPath;

  // Resolve absolute path via `which` so we can use execFile without shell: true
  for (const bin of ["claude", "claude-code"]) {
    try {
      const { stdout } = await execFileAsync("which", [bin]);
      _claudeBinaryPath = stdout.trim();
      return _claudeBinaryPath;
    } catch {
      // not found, try next
    }
  }
  throw new Error(
    "Claude Code CLI not found. Looked for 'claude' and 'claude-code' on PATH.\n" +
      "  Install: npm install -g @anthropic-ai/claude-code\n" +
      "  Or switch to a different provider: emit init"
  );
}

async function callClaudeCode(prompt: string): Promise<string> {
  const bin = await findClaudeBinary();

  return new Promise<string>((resolve, reject) => {
    // Pipe prompt via stdin instead of as a CLI argument to avoid
    // arg-length limits and the "no stdin data" warning.
    // Timeout is 120s by default; long-running calls (complex prompts, large
    // outputs) can exceed this. Opt-in override via EMIT_CLAUDE_CODE_TIMEOUT_MS
    // for dev/debug use without changing the default for existing commands.
    const timeoutMs =
      Number(process.env.EMIT_CLAUDE_CODE_TIMEOUT_MS) || 120_000;
    const child = spawn(bin, ["-p", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    child.stdin!.end(prompt);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout!.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err: any) => {
      if (err.code === "ENOENT") {
        reject(new Error(
          "Claude Code CLI not found on PATH.\n" +
            "  Install: npm install -g @anthropic-ai/claude-code\n" +
            "  Or switch to a different provider: emit init"
        ));
      } else {
        reject(new Error(`Claude Code CLI error: ${err.message}`));
      }
    });

    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString().trim();
      const stderr = Buffer.concat(stderrChunks).toString().trim();
      if (code === 0) {
        resolve(stdout);
      } else {
        const detail = stderr || stdout || `exited with code ${code}`;
        const truncated = detail.length > 500 ? detail.slice(0, 500) + "..." : detail;
        reject(new Error(`Claude Code CLI error: ${truncated}`));
      }
    });
  });
}

async function callAnthropic(
  prompt: string,
  model: string,
  maxTokens: number,
  retries = 3
): Promise<string> {
  const client = getAnthropicClient();
  try {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    return response.content[0].type === "text" ? response.content[0].text : "";
  } catch (err: any) {
    // Retry on rate limit (429) with a 65s wait to allow the 1-minute window to reset
    if (err?.status === 429 && retries > 0) {
      const waitMs = 65_000;
      process.stderr.write(
        `[emit] Rate limit hit — waiting ${waitMs / 1000}s before retry (${retries} left)...\n`
      );
      await new Promise((r) => setTimeout(r, waitMs));
      return callAnthropic(prompt, model, maxTokens, retries - 1);
    }
    throw err;
  }
}

async function callOpenAICompat(
  prompt: string,
  model: string,
  maxTokens: number,
  baseUrl: string,
  apiKeyEnv?: string
): Promise<string> {
  const keyEnvName = apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = process.env[keyEnvName];
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM API error ${res.status}: ${body}`);
  }
  const data = (await res.json()) as any;
  return data.choices?.[0]?.message?.content ?? "";
}

/**
 * Route a prompt to the correct LLM provider based on LlmCallConfig.
 */
export async function callLLM(
  prompt: string,
  cfg: LlmCallConfig
): Promise<string> {
  switch (cfg.provider) {
    case "claude-code":
      return callClaudeCode(prompt);

    case "anthropic":
      return callAnthropic(prompt, cfg.model, cfg.max_tokens);

    case "openai":
      return callOpenAICompat(
        prompt,
        cfg.model,
        cfg.max_tokens,
        "https://api.openai.com/v1",
        "OPENAI_API_KEY"
      );

    case "openai-compatible": {
      if (!cfg.base_url) {
        throw new Error(
          "llm.base_url is required when provider is openai-compatible"
        );
      }
      return callOpenAICompat(
        prompt,
        cfg.model,
        cfg.max_tokens,
        cfg.base_url,
        cfg.api_key_env
      );
    }

    case "platform":
      throw new Error(
        "The 'platform' provider is not yet available. Use claude-code, anthropic, openai, or openai-compatible."
      );

    default: {
      const _exhaustive: never = cfg.provider;
      throw new Error(`Unknown LLM provider: ${_exhaustive}`);
    }
  }
}

export function parseJsonResponse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const stripped = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
    try {
      return JSON.parse(stripped) as T;
    } catch {
      return fallback;
    }
  }
}
