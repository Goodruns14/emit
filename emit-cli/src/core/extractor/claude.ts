import { execFile } from "child_process";
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

async function findClaudeBinary(): Promise<string> {
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
  try {
    const { stdout } = await execFileAsync(bin, ["-p", prompt], {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new Error(
        "Claude Code CLI not found on PATH.\n" +
          "  Install: npm install -g @anthropic-ai/claude-code\n" +
          "  Or switch to a different provider: emit init"
      );
    }
    throw new Error(`Claude Code CLI error: ${err.message}`);
  }
}

async function callAnthropic(
  prompt: string,
  model: string,
  maxTokens: number
): Promise<string> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  return response.content[0].type === "text" ? response.content[0].text : "";
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
