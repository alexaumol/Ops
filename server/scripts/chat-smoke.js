/**
 * Ops assistant smoke test — `npm run chat:smoke` (from server/).
 * ---------------------------------------------------------------------------
 * Checks the Azure OpenAI wiring end to end, WITHOUT touching the database:
 *   1. config present
 *   2. a plain completion round-trips (endpoint + deployment + key line up)
 *   3. with the real tool definitions offered, the model chooses to call a
 *      tool for a data question (proves function-calling works with this
 *      model + api-version)
 *
 * It does NOT execute the tool (that needs the DB) — run a real question in
 * the app for that. Exit 0 on success, 1 on any failure.
 * ---------------------------------------------------------------------------
 */
require("dotenv").config();

const { chatLlmConfigured, chatCompletion, DEPLOYMENT } = require("../lib/chatLlm");
const { tools } = require("../lib/chatTools");

async function main() {
  if (!chatLlmConfigured()) {
    console.error("✗ Azure OpenAI is not configured — set AZURE_OPENAI_ENDPOINT / _API_KEY / _DEPLOYMENT in server/.env");
    process.exit(1);
  }
  console.log(`• deployment: ${DEPLOYMENT}`);
  console.log(`• endpoint:   ${process.env.AZURE_OPENAI_ENDPOINT}`);

  // 1. plain completion
  process.stdout.write("• plain completion … ");
  const a = await chatCompletion({
    messages: [{ role: "user", content: 'Reply with exactly the word: ok' }],
    maxTokens: 50,
  });
  const text = (a.choices?.[0]?.message?.content || "").trim().toLowerCase();
  if (!text.includes("ok")) {
    console.log(`unexpected reply: ${JSON.stringify(a).slice(0, 400)}`);
    process.exit(1);
  }
  console.log("ok");

  // 2. tool-calling
  process.stdout.write(`• function-calling (${tools.length} tools offered) … `);
  const b = await chatCompletion({
    messages: [
      { role: "system", content: "Use a tool to answer data questions. Do not answer from memory." },
      { role: "user", content: "What does budgeted vs invoiced look like across the whole portfolio?" },
    ],
    tools,
    maxTokens: 300,
  });
  const calls = b.choices?.[0]?.message?.tool_calls || [];
  if (!calls.length) {
    console.log("model did NOT call a tool — check the model / api-version");
    console.log(JSON.stringify(b.choices?.[0]?.message, null, 2).slice(0, 600));
    process.exit(1);
  }
  console.log(`ok → called ${calls.map((c) => c.function?.name).join(", ")}`);

  console.log("\n✓ Azure OpenAI wiring is good. Ask a real question in the app to exercise the tools + DB.");
}

main().catch((err) => {
  console.error("\n✗ smoke test failed:", err.message);
  process.exit(1);
});
