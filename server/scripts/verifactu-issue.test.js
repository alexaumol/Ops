/**
 * Unit tests for server/lib/verifactu/issue.js — the pure bits:
 * `toOpsInvoice` (DB rows → normalised invoice) and `nextInvoiceNumber`'s
 * code format. The DB / network paths are covered by the sandbox smoke test.
 *
 *   npm run verifactu:test        (runs this + the mapping suite)
 */
// issue.js transitively pulls in config/db.js (for its non-pure functions);
// load .env first so that module doesn't warn about missing PG* vars. The
// tests below never touch the DB.
require("../lib/loadEnv");
const test = require("node:test");
const assert = require("node:assert/strict");
const { toOpsInvoice, madridDate } = require("../lib/verifactu/issue");
const { buildAltaPayload } = require("../lib/verifactu/mapping");

function rows(over = {}) {
  return {
    invoice: {
      id: 42, invoicecode: "2026-014", invoiceyear: 2026, invoiceseq: 14,
      iscorrective: false, sourceinvoiceid: null, projectid: 7, entityid: 3,
      ...over.invoice,
    },
    details: {
      amount: 1000, invoicedate: "2026-02-10", descriptionservice: "<div>Consulting — Feb</div>",
      vatid: 4, vatamount: 210, currency: "EUR", busspartnertoinvoiceid: 9, issued_at: null,
      ...over.details,
    },
    entity: { id: 3, vatnumber: "ESB12345678", verifactu_enabled: true, verifactu_api_key: "k",
      verifactu_environment: "sandbox", invoice_series: "HITT", ...over.entity },
    taxCompany: over.taxCompany === null ? null : {
      taxcompanyname: "Client SL", vatnumber: "B87654321", fiscalidtype: null,
      fiscalcountry: null, ...over.taxCompany },
    vatType: { percentage: 21, verifactu_vatoperation: "S1", verifactu_vatkey: "01",
      verifactu_exemption_note: null, ...over.vatType },
    correctedInvoices: over.correctedInvoices || [],
  };
}

test("madridDate pins to Europe/Madrid regardless of host TZ", () => {
  // 23:30 UTC on 2026-06-30 is already 2026-07-01 01:30 in Madrid (CEST)
  assert.equal(madridDate("2026-06-30T23:30:00Z"), "2026-07-01");
  assert.equal(madridDate("2026-02-10T09:00:00Z"), "2026-02-10");
});

test("toOpsInvoice: taxed F1 with a Spanish recipient", () => {
  const ops = toOpsInvoice(rows());
  assert.equal(ops.number, "2026-014");
  assert.equal(ops.issuedDate, "2026-02-10");
  assert.equal(ops.type, "F1");
  assert.equal(ops.description, "Consulting — Feb"); // HTML stripped
  assert.deepEqual(ops.recipient, {
    name: "Client SL", fiscalId: "B87654321", fiscalIdType: "nif", country: "ES",
  });
  assert.equal(ops.net, 1000);
  assert.equal(ops.vat.rate, 21);
  assert.equal(ops.vat.amount, 210);
  assert.equal(ops.vat.operation, "S1");
  // and it produces a valid BOLD payload
  const { invoice } = buildAltaPayload(ops);
  assert.deepEqual(invoice.vatLines, [{ base: 1000, rate: 21, amount: 210, vatOperation: "S1", vatKey: "01" }]);
  assert.equal(invoice.total, 1210);
});

test("toOpsInvoice: foreign recipient carries idType + country", () => {
  const ops = toOpsInvoice(rows({
    taxCompany: { taxcompanyname: "Lavazza SpA", vatnumber: "IT00470550013", fiscalidtype: "02", fiscalcountry: "IT" },
  }));
  assert.deepEqual(ops.recipient, {
    name: "Lavazza SpA", fiscalId: "IT00470550013", fiscalIdType: "02", country: "IT",
  });
  const { invoice } = buildAltaPayload(ops);
  assert.deepEqual(invoice.recipient, { id: "IT00470550013", idType: "02", name: "Lavazza SpA", country: "IT" });
});

test("toOpsInvoice: 0% VAT type with a seeded E1 default → exempt line", () => {
  const ops = toOpsInvoice(rows({
    details: { amount: 500, vatamount: 0 },
    vatType: { percentage: 0, verifactu_vatoperation: "E1", verifactu_vatkey: "01" },
  }));
  assert.equal(ops.vat.rate, 0);
  assert.equal(ops.vat.operation, "E1");
  const { invoice } = buildAltaPayload(ops);
  assert.deepEqual(invoice.vatLines, [{ base: 500, rate: 0, amount: 0, vatOperation: "E1", vatKey: "01" }]);
  assert.equal(invoice.total, 500);
});

test("toOpsInvoice: corrective pulls the source code + date into creditNote", () => {
  const ops = toOpsInvoice(rows({
    invoice: { iscorrective: true, sourceinvoiceid: 40 },
    correctedInvoices: [{ invoicecode: "2026-009", invoicedate: "2026-01-15" }],
  }));
  assert.equal(ops.type, "R1");
  assert.deepEqual(ops.correctedInvoices, [{ number: "2026-009", issuedDate: "2026-01-15" }]);
  const { invoice } = buildAltaPayload(ops);
  assert.equal(invoice.type, "R1");
  assert.deepEqual(invoice.creditNote.ids, [{ number: "2026-009", issuedTime: "2026-01-15" }]);
});

test("toOpsInvoice: no recipient tax company → recipient null (mapping then rejects for F1)", () => {
  const ops = toOpsInvoice(rows({ taxCompany: null }));
  assert.equal(ops.recipient, null);
  assert.throws(() => buildAltaPayload(ops), /recipient is required/);
});
