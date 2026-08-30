/**
 * Azure OpenAI chat-completions client (for the Ops assistant).
 * ---------------------------------------------------------------------------
 * Deliberately dependency-free (fetch only), same style as lib/graph.js.
 * Talks to a chat-completions deployment on an Azure OpenAI resource — keep
 * that resource in an EU region; Azure OpenAI does not train on prompt data
 * and keeps it in-region.
 *
 * Config (server/.env — see .env.example):
 *   AZURE_OPENAI_ENDPOINT      https://<resource>.openai.azure.com
 *   AZURE_OPENAI_API_KEY       one of the resource's keys
 *   AZURE_OPENAI_DEPLOYMENT    the deployment name (e.g. "gpt-4.1")
 *   AZURE_OPENAI_API_VERSION   optional, defaults below
 *
 * If any of the first three are missing, chatLlmConfigured() returns false
 * and routes/chat.js answers 503 instead of erroring.
 * ---------------------------------------------------------------------------
 */
const ENDPOINT = (process.env.AZURE_OPENAI_ENDPOINT || "").replace(/\/$/, "");
const API_KEY = process.env.AZURE_OPENAI_API_KEY || "";
const DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || "";
const API_VERSION = process.env.AZURE_OPENAI_API_VERSION || "2024-10-21";

function chatLlmConfigured() {
  return !!(ENDPOINT && API_KEY && DEPLOYMENT);
}

/**
 * One chat-completions call. Returns the raw Azure response JSON — the
 * caller inspects choices[0].message for content vs tool_calls.
 *
 * @param {object}   opts
 * @param {object[]} opts.messages      OpenAI-format message list
 * @param {object[]} [opts.tools]       tool (function) definitions
 * @param {string|object} [opts.toolChoice="auto"]
 * @param {number}   [opts.temperature=0.2]
 * @param {number}   [opts.maxTokens=900]
 * @param {AbortSignal} [opts.signal]
 */
async function chatCompletion({ messages, tools, toolChoice = "auto", temperature = 0.2, maxTokens = 900, signal }) {
  if (!chatLlmConfigured()) {
    throw new Error("Azure OpenAI is not configured (AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY / AZURE_OPENAI_DEPLOYMENT)");
  }
  const url = `${ENDPOINT}/openai/deployments/${encodeURIComponent(DEPLOYMENT)}/chat/completions?api-version=${encodeURIComponent(API_VERSION)}`;
  const body = {
    messages,
    temperature,
    max_tokens: maxTokens,
    ...(tools && tools.length ? { tools, tool_choice: toolChoice } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": API_KEY },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Azure OpenAI ${res.status} ${res.statusText}: ${text.slice(0, 600)}`);
  }
  return res.json();
}

module.exports = { chatLlmConfigured, chatCompletion, DEPLOYMENT, API_VERSION };
