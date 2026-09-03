/**
 * Azure OpenAI chat-completions client (for the Ops assistant).
 * ---------------------------------------------------------------------------
 * Dependency-free (fetch only), same style as lib/graph.js.
 *
 * Built for the GPT-5 family (e.g. gpt-5-mini) on Azure's newer "v1" API
 * surface — the OpenAI-compatible endpoint whose URL ends in /openai/v1.
 * Key differences from the older gpt-4.x path, all handled here:
 *   - the model is the DEPLOYMENT NAME, passed in the body as `model`
 *   - `max_completion_tokens`, not `max_tokens`
 *   - no `temperature` override (GPT-5 only allows the default)
 *   - `reasoning_effort` controls latency vs depth ("minimal".."high")
 *
 * A classic endpoint (…/openai, or a bare resource host) still works — the
 * URL builder falls back to /openai/deployments/<name>/chat/completions.
 *
 * Config (server/.env — see .env.example):
 *   AZURE_OPENAI_ENDPOINT             https://<res>.openai.azure.com/openai/v1
 *   AZURE_OPENAI_API_KEY              a key from the resource
 *   AZURE_OPENAI_DEPLOYMENT           the deployment name (e.g. ops-hitt-gpt-51)
 *   AZURE_OPENAI_API_VERSION          optional; only needed for preview features
 *   AZURE_OPENAI_REASONING_EFFORT     optional; default "low"
 *   AZURE_OPENAI_MAX_TOKENS           optional; default 1400 (completion cap)
 *
 * Missing any of the first three => chatLlmConfigured() is false and
 * routes/chat.js answers 503.
 * ---------------------------------------------------------------------------
 */
const ENDPOINT = (process.env.AZURE_OPENAI_ENDPOINT || "").replace(/\/+$/, "");
const API_KEY = process.env.AZURE_OPENAI_API_KEY || "";
const DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || "";
const API_VERSION = process.env.AZURE_OPENAI_API_VERSION || "";
const REASONING_EFFORT = process.env.AZURE_OPENAI_REASONING_EFFORT || "low";
const VERBOSITY = process.env.AZURE_OPENAI_VERBOSITY || ""; // "" = model default
const MAX_COMPLETION_TOKENS = Number(process.env.AZURE_OPENAI_MAX_TOKENS) || 1400;
// "api-key" (default, works on both Azure surfaces) or "bearer" (send the
// key as Authorization: Bearer — try this if a v1 endpoint rejects api-key).
const AUTH_STYLE = (process.env.AZURE_OPENAI_AUTH_STYLE || "api-key").toLowerCase();

const IS_V1 = /\/openai\/v1$/.test(ENDPOINT);

function chatLlmConfigured() {
  return !!(ENDPOINT && API_KEY && DEPLOYMENT);
}

function completionsUrl() {
  if (IS_V1) {
    const url = `${ENDPOINT}/chat/completions`;
    return API_VERSION ? `${url}?api-version=${encodeURIComponent(API_VERSION)}` : url;
  }
  // Classic path: strip a trailing /openai (or /openai/v1) then rebuild.
  const host = ENDPOINT.replace(/\/openai(\/v1)?$/, "");
  const ver = API_VERSION || "2024-10-21";
  return `${host}/openai/deployments/${encodeURIComponent(DEPLOYMENT)}/chat/completions?api-version=${encodeURIComponent(ver)}`;
}

/**
 * One chat-completions call. Returns the raw response JSON — the caller
 * inspects choices[0].message for content vs tool_calls (shape is identical
 * on both API surfaces).
 *
 * @param {object}   opts
 * @param {object[]} opts.messages
 * @param {object[]} [opts.tools]
 * @param {string|object} [opts.toolChoice="auto"]
 * @param {number}   [opts.maxTokens]
 * @param {AbortSignal} [opts.signal]
 */
async function chatCompletion({ messages, tools, toolChoice = "auto", maxTokens, signal }) {
  if (!chatLlmConfigured()) {
    throw new Error("Azure OpenAI is not configured (AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY / AZURE_OPENAI_DEPLOYMENT)");
  }

  const body = {
    model: DEPLOYMENT, // required on the v1 surface; ignored on the classic one
    messages,
    max_completion_tokens: maxTokens || MAX_COMPLETION_TOKENS,
    ...(REASONING_EFFORT && REASONING_EFFORT !== "default" ? { reasoning_effort: REASONING_EFFORT } : {}),
    ...(VERBOSITY ? { verbosity: VERBOSITY } : {}),
    ...(tools && tools.length ? { tools, tool_choice: toolChoice } : {}),
  };

  const authHeader = AUTH_STYLE === "bearer"
    ? { Authorization: `Bearer ${API_KEY}` }
    : { "api-key": API_KEY };

  const res = await fetch(completionsUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Azure OpenAI ${res.status} ${res.statusText}: ${text.slice(0, 600)}`);
  }
  return res.json();
}

module.exports = { chatLlmConfigured, chatCompletion, DEPLOYMENT };
