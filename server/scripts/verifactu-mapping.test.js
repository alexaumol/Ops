/**
 * Unit tests for server/lib/verifactu/mapping.js — the Ops-invoice →
 * BOLD-payload transform. Pure, no DB / network.
 *
 *   npm run verifactu:test        (from server/)
 *   node --test scripts/verifactu-mapping.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAltaPayload, normalizeFiscalId, money } = require("../lib/verifactu/mapping");

// A date safely in the past but after the Veri*Factu start, reused everywhere.
const D = "2025-03-10";

function baseInvoice(overrides = {}) {
  return {
    number: "HITT-2026-014",
    issuedDate: D,
    description: "Consulting services — project 2411",
    issuer: { nif: "B12345678" },
    recipient: { name: "Client SL", fiscalId: "B87654321", country: "ES" },
    net: 100,
    vat: { rate: 21, amount: 21 },
    total: 121,
    ...overrides,
  };
}

test("normalizeFiscalId strips ES prefix, punctuation, and cases up", () => {
  assert.equal(normalizeFiscalId("es b-1234.567 z"), "B1234567Z");
  assert.equal(normalizeFiscalId("B87654321"), "B87654321");
  assert.equal(normalizeFiscalId(null), null);
  assert.equal(normalizeFiscalId("  "), null);
});

test("money rounds to 2 decimals without fp drift", () => {
  assert.equal(money(1.005), 1.01);
  assert.equal(money(21), 21);
  assert.equal(money(0.1 + 0.2), 0.3);
});

test("F1 with a Spanish NIF recipient → irsId form", () => {
  const { invoice } = buildAltaPayload(baseInvoice());
  assert.equal(invoice.type, "F1");
  assert.deepEqual(invoice.id, { number: "HITT-2026-014", issuedTime: D });
  assert.deepEqual(invoice.recipient, { irsId: "B87654321", name: "Client SL", country: "ES" });
  assert.deepEqual(invoice.description, { text: "Consulting services — project 2411", operationDate: D });
  assert.deepEqual(invoice.vatLines, [{ base: 100, rate: 21, amount: 21, vatOperation: "S1", vatKey: "01" }]);
  assert.equal(invoice.amount, 21);
  assert.equal(invoice.total, 121);
});

test("operationDate defaults to issuedDate but is kept when given", () => {
  const { invoice } = buildAltaPayload(baseInvoice({ operationDate: "2025-03-01" }));
  assert.equal(invoice.description.operationDate, "2025-03-01");
});

test("foreign recipient → id + idType + country form", () => {
  const { invoice } = buildAltaPayload(baseInvoice({
    recipient: { name: "Lavazza SpA", fiscalId: "IT00470550013", fiscalIdType: "02", country: "it" },
  }));
  assert.deepEqual(invoice.recipient, { id: "IT00470550013", idType: "02", name: "Lavazza SpA", country: "IT" });
});

test("foreign recipient without a country is rejected", () => {
  assert.throws(
    () => buildAltaPayload(baseInvoice({ recipient: { name: "X", fiscalId: "X1", fiscalIdType: "04" } })),
    /country .* is required/,
  );
});

test("zero-rate line defaults to E1 exempt with amount 0", () => {
  const { invoice } = buildAltaPayload(baseInvoice({ net: 100, vat: { rate: 0 }, total: 100 }));
  assert.deepEqual(invoice.vatLines, [{ base: 100, rate: 0, amount: 0, vatOperation: "E1", vatKey: "01" }]);
  assert.equal(invoice.amount, 0);
  assert.equal(invoice.total, 100);
});

test("explicit reverse charge (S2) forces amount 0", () => {
  const { invoice } = buildAltaPayload(baseInvoice({
    net: 100, vat: { rate: 0, operation: "S2" }, total: 100,
  }));
  assert.deepEqual(invoice.vatLines[0], { base: 100, rate: 0, amount: 0, vatOperation: "S2", vatKey: "01" });
});

test("corrective (isCorrective) → R1 + creditNote referencing the source", () => {
  const { invoice } = buildAltaPayload(baseInvoice({
    isCorrective: true,
    correctedInvoices: [{ number: "HITT-2026-009", issuedDate: "2025-02-01" }],
  }));
  assert.equal(invoice.type, "R1");
  assert.deepEqual(invoice.creditNote, {
    style: "I",
    ids: [{ number: "HITT-2026-009", issuedTime: "2025-02-01" }],
  });
});

test("corrective without correctedInvoices is rejected", () => {
  assert.throws(() => buildAltaPayload(baseInvoice({ isCorrective: true })), /requires correctedInvoices/);
});

test("simplified F2 may omit the recipient", () => {
  const { invoice } = buildAltaPayload(baseInvoice({ type: "F2", recipient: null }));
  assert.equal(invoice.type, "F2");
  assert.equal(invoice.recipient, undefined);
});

test("non-simplified invoice without a recipient is rejected", () => {
  assert.throws(() => buildAltaPayload(baseInvoice({ recipient: null })), /recipient is required/);
});

test("a future issuedDate is rejected", () => {
  const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  assert.throws(() => buildAltaPayload(baseInvoice({ issuedDate: future })), /in the future/);
});

test("an issuedDate before 2024-07-01 is rejected", () => {
  assert.throws(() => buildAltaPayload(baseInvoice({ issuedDate: "2024-06-30" })), /before the Veri\*Factu start/);
});

test("a bad VAT rate is rejected", () => {
  assert.throws(() => buildAltaPayload(baseInvoice({ vat: { rate: 7, amount: 7 } })), /vat\.rate must be one of/);
});

test("missing number / empty description are rejected", () => {
  assert.throws(() => buildAltaPayload(baseInvoice({ number: "  " })), /number is required/);
  assert.throws(() => buildAltaPayload(baseInvoice({ description: "" })), /must not be empty/);
});

test("VAT amount is derived from base×rate when not supplied", () => {
  const { invoice } = buildAltaPayload(baseInvoice({ net: 200, vat: { rate: 10 }, total: 220 }));
  assert.equal(invoice.vatLines[0].amount, 20);
  assert.equal(invoice.amount, 20);
});
