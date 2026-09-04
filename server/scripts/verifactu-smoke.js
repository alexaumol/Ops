/**
 * Veri*Factu sandbox smoke test.
 * ---------------------------------------------------------------------------
 * Registers one sample invoice against BOLD's sandbox, then reads its state
 * and re-fetches its data. Manual — needs a sandbox API key, hits the
 * network, and (harmlessly) creates a record in the sandbox.
 *
 *   VERIFACTU_API_KEY=sk_sandbox_xxx npm run verifactu:smoke     # from server/
 *
 * Optional env:
 *   VERIFACTU_ISSUER_NIF   the NIF of the company the API-Key belongs to —
 *                          your assigned sandbox company, e.g. "EMPRESA DE
 *                          PRUEBAS (PI4)" (find its NIF in the BOLD console).
 *                          Sent as the Verify-Issuer-Id guard. LEAVE UNSET to
 *                          skip the guard entirely (the API-Key still
 *                          identifies the company). Sending the wrong NIF
 *                          here is error 000007.
 *   VERIFACTU_BASE_URL     default https://vf1.boldsoftware.es/v1
 *   VERIFACTU_SMOKE_NUMBER default SMOKE-<timestamp>
 *
 * Note: in sandbox BOLD auto-prefixes every invoice number with your test
 * company code — e.g. "PI4-". So a number sent as "SMOKE-123" comes back
 * (in chainInfo / verifactuUrl) as "PI4-SMOKE-123". Expected.
 * ---------------------------------------------------------------------------
 */
require("../lib/loadEnv");
const bold = require("../lib/verifactu/bold");
const { buildAltaPayload } = require("../lib/verifactu/mapping");
const { VerifactuError } = require("../lib/verifactu/errors");

const apiKey = process.env.VERIFACTU_API_KEY;
const issuerNif = process.env.VERIFACTU_ISSUER_NIF || null; // null → guard header omitted
const number = process.env.VERIFACTU_SMOKE_NUMBER || `SMOKE-${Date.now()}`;

// A safe test recipient — the NIF BOLD uses in its own examples. It is NOT
// the issuer (that's whatever company your API-Key belongs to).
const RECIPIENT = { name: "BOLD Software SL", fiscalId: "B13674197", country: "ES" };

if (!apiKey) {
  console.error("Set VERIFACTU_API_KEY (a BOLD sandbox key) and re-run.");
  process.exit(1);
}

function short(s, n = 80) {
  if (s == null) return s;
  const str = String(s);
  return str.length > n ? `${str.slice(0, n)}…(${str.length} chars)` : str;
}

(async () => {
  const payload = buildAltaPayload({
    number,
    issuedDate: new Date().toISOString().slice(0, 10),
    description: "Veri*Factu integration smoke test — safe to ignore",
    recipient: RECIPIENT,
    net: 100,
    vat: { rate: 21, amount: 21 },
    total: 121,
  });

  console.log(`→ base URL   ${bold.baseUrl()}`);
  console.log(`→ issuer NIF ${issuerNif || "(guard not sent — VERIFACTU_ISSUER_NIF unset)"}`);
  console.log(`→ number     ${number}`);
  console.log(`→ payload    ${JSON.stringify(payload)}`);
  console.log();

  let reg;
  try {
    reg = await bold.register(payload, { apiKey, issuerNif });
  } catch (err) {
    if (err instanceof VerifactuError) {
      console.error(`✗ register failed [${err.category}${err.code ? " / " + err.code : ""}]: ${err.message}`);
      if (err.requestId) console.error(`  requestId: ${err.requestId}`);
    } else {
      console.error("✗ register threw:", err);
    }
    process.exit(2);
  }

  console.log("✓ registered");
  console.log(`  queueId       ${reg.queueId}`);
  console.log(`  requestId     ${reg.requestId}`);
  console.log(`  verifactuUrl  ${reg.verifactuUrl}`);
  console.log(`  qrcode        ${short(reg.qrcode)}`);
  console.log(`  chainInfo     ${JSON.stringify(reg.chainInfo)}`);
  console.log(`  verifactuXml  ${short(reg.verifactuXml)}`);
  console.log();

  try {
    const st = await bold.state(reg.queueId, { apiKey, issuerNif });
    console.log(`✓ state       ${JSON.stringify(st)}`);
  } catch (err) {
    console.error(`✗ state failed: ${err.message}`);
  }

  try {
    const dt = await bold.data(reg.queueId, { apiKey, issuerNif });
    console.log(`✓ data        queueId=${dt.queueId} verifactuUrl=${dt.verifactuUrl} qr=${short(dt.qrcode, 40)}`);
  } catch (err) {
    console.error(`✗ data failed: ${err.message}`);
  }

  console.log("\nDone. Cross-check the QR against the AEAT sandbox validator:");
  console.log("  https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR");
})();
