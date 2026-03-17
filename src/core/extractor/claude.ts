import Anthropic from "@anthropic-ai/sdk";

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

async function callOpenAI(
  prompt: string,
  model: string,
  maxTokens: number
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing required environment variable: OPENAI_API_KEY\n" +
        "  Get your key at https://platform.openai.com/api-keys"
    );
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${body}`);
  }
  const data = (await res.json()) as any;
  return data.choices?.[0]?.message?.content ?? "";
}

async function callOllama(
  prompt: string,
  model: string,
  maxTokens: number
): Promise<string> {
  // Strip the "ollama/" prefix to get the actual model name
  const ollamaModel = model.replace(/^ollama\//, "");
  const baseUrl = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama API error ${res.status}: ${body}`);
  }
  const data = (await res.json()) as any;
  return data.choices?.[0]?.message?.content ?? "";
}

/**
 * Route a prompt to the correct LLM provider based on the model name:
 *   - "ollama/<model>"  → local Ollama (OLLAMA_HOST or http://localhost:11434)
 *   - "gpt-*" / "o1-*" / "o3-*" → OpenAI (OPENAI_API_KEY)
 *   - anything else     → Anthropic (ANTHROPIC_API_KEY)
 */
export async function callLLM(
  prompt: string,
  model: string,
  maxTokens: number
): Promise<string> {
  if (model.startsWith("ollama/")) {
    return callOllama(prompt, model, maxTokens);
  }
  if (model.startsWith("gpt-") || model.startsWith("o1-") || model.startsWith("o3-")) {
    return callOpenAI(prompt, model, maxTokens);
  }
  return callAnthropic(prompt, model, maxTokens);
}

/** @deprecated Use callLLM */
export const callClaude = callLLM;

export function parseJsonResponse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    // Try stripping markdown code fences if present
    const stripped = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
    try {
      return JSON.parse(stripped) as T;
    } catch {
      return fallback;
    }
  }
}
