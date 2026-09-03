/**
 * Veri*Factu — payload mapping
 * ---------------------------------------------------------------------------
 * Pure functions: an Ops invoice (already assembled from the DB by the
 * caller — routes/invoicing.js in phase V2) → the `{ invoice: {...} }` body
 * BOLD's `POST /invoice` expects.
 *
 * No DB, no network, no `process.env` — so it is unit-tested directly
 * (scripts/verifactu-mapping.test.js).
 *
 * Field reference: docs/verifactu-boldsoftware-openapi.yaml.
 * ---------------------------------------------------------------------------
 */

/** Earliest issue date the AEAT accepts (Veri*Factu regime start). */
const MIN_ISSUE_DATE = "2024-07-01";

class MappingError extends Error {
  constructor(message) {
    super(message);
    this.name = "MappingError";
  }
}

/** Strip a leading ES country prefix, upper-case, trim. `"es b1234"` → `"B1234"`. */
function normalizeFiscalId(raw) {
  if (raw == null) return null;
  const s = String(raw).toUpperCase().replace(/[\s.\-/]/g, "");
  const m = /^ES([0-9A-Z].*)$/.exec(s);
  return (m ? m[1] : s) || null;
}

/** 2-decimal round that avoids binary-fp surprises (1.005 → 1.01). */
function money(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function isYmd(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/**
 * @typedef {Object} OpsInvoice
 * @property {string}  number          final fiscal number, e.g. "HITT-2026-014"
 * @property {string}  issuedDate      YYYY-MM-DD — the issue date (`issuedTime`)
 * @property {string} [operationDate]  YYYY-MM-DD — defaults to issuedDate
 * @property {string}  description     non-empty free text (the service description)
 * @property {"F1"|"F2"|"F3"|"R1"|"R2"|"R3"|"R4"|"R5"} [type]  default "F1", or "R1" when isCorrective
 * @property {boolean} [isCorrective]  shorthand: forces type "R1" + creditNote
 * @property {Array<{number:string, issuedDate:string}>} [correctedInvoices]  required for R1..R5
 * @property {{ nif:string }} issuer   the issuing entity's NIF (also sent as Verify-Issuer-Id)
 * @property {OpsRecipient|null} recipient   null only allowed for F2 (simplified)
 * @property {number}  net             taxable base
 * @property {OpsVatLine} vat          the single VAT line Ops models today
 * @property {number}  total           invoice total (gross)
 *
 * @typedef {Object} OpsRecipient
 * @property {string}  name
 * @property {string} [fiscalIdType]   "nif" | null → Spanish NIF form; "02".."07" → foreign/doc form
 * @property {string}  fiscalId        raw — normalised here
 * @property {string} [country]        ISO-3166-1 alpha-2; defaults "ES" for the NIF form
 *
 * @typedef {Object} OpsVatLine
 * @property {number}  rate            0 | 4 | 5 | 10 | 21
 * @property {number}  amount          VAT quota for the line
 * @property {string} [operation]      S1 | S2 | N1 | N2 | E1..E6  (default S1, or E1 when rate 0)
 * @property {string} [key]            régimen de IVA clave (default "01")
 */

/**
 * @param {OpsInvoice} inv
 * @returns {{ invoice: object }}
 */
function buildAltaPayload(inv) {
  if (!inv || typeof inv !== "object") throw new MappingError("invoice object is required");

  const number = String(inv.number || "").trim();
  if (!number) throw new MappingError("invoice.number is required");

  if (!isYmd(inv.issuedDate)) throw new MappingError(`issuedDate must be YYYY-MM-DD (got ${JSON.stringify(inv.issuedDate)})`);
  const operationDate = inv.operationDate == null ? inv.issuedDate : inv.operationDate;
  if (!isYmd(operationDate)) throw new MappingError(`operationDate must be YYYY-MM-DD (got ${JSON.stringify(inv.operationDate)})`);

  if (inv.issuedDate < MIN_ISSUE_DATE) {
    throw new MappingError(`issuedDate ${inv.issuedDate} is before the Veri*Factu start date ${MIN_ISSUE_DATE}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  if (inv.issuedDate > today) {
    throw new MappingError(`issuedDate ${inv.issuedDate} is in the future`);
  }

  const description = String(inv.description || "").trim();
  if (!description) throw new MappingError("invoice.description must not be empty");

  const type = inv.type || (inv.isCorrective ? "R1" : "F1");
  const isCorrective = /^R[1-5]$/.test(type);
  const isSimplified = type === "F2" || type === "R5";

  // ---- recipient -------------------------------------------------------
  let recipient;
  if (inv.recipient == null) {
    if (!isSimplified) throw new MappingError(`recipient is required for invoice type ${type}`);
    recipient = undefined;
  } else {
    const r = inv.recipient;
    const name = String(r.name || "").trim();
    if (!name) throw new MappingError("recipient.name is required");
    const fiscalId = normalizeFiscalId(r.fiscalId);
    if (!fiscalId) throw new MappingError("recipient.fiscalId is required");
    const idType = r.fiscalIdType == null || r.fiscalIdType === "nif" ? null : String(r.fiscalIdType);

    if (idType == null) {
      recipient = { irsId: fiscalId, name, country: (r.country || "ES").toUpperCase() };
    } else {
      const country = String(r.country || "").toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) {
        throw new MappingError(`recipient.country (2-letter) is required for fiscalIdType ${idType}`);
      }
      recipient = { id: fiscalId, idType, name, country };
    }
  }

  // ---- VAT line -------------------------------------------------------
  const v = inv.vat || {};
  const rate = Number(v.rate);
  if (![0, 4, 5, 10, 21].includes(rate)) {
    throw new MappingError(`vat.rate must be one of 0, 4, 5, 10, 21 (got ${JSON.stringify(v.rate)})`);
  }
  const base = money(inv.net);
  let operation = v.operation || (rate === 0 ? "E1" : "S1");
  const exempt = /^E[1-6]$/.test(operation);
  const notSubject = operation === "N1" || operation === "N2";
  let vatAmount = exempt || notSubject ? 0 : money(v.amount != null ? v.amount : base * (rate / 100));

  if ((exempt || notSubject) && rate !== 0) {
    throw new MappingError(`vatOperation ${operation} requires rate 0 (got ${rate})`);
  }
  if (operation === "S1" && (rate === 0 || vatAmount === 0)) {
    throw new MappingError("vatOperation S1 requires a non-zero rate and amount");
  }

  const vatLine = { base, rate, amount: vatAmount, vatOperation: operation, vatKey: v.key || "01" };

  // ---- totals --------------------------------------------------------
  const totalVat = money(vatAmount);
  const total = money(inv.total != null ? inv.total : base + vatAmount);

  // ---- assemble -----------------------------------------------------
  const invoice = {
    id: { number, issuedTime: inv.issuedDate },
    description: { text: description, operationDate },
    type,
    vatLines: [vatLine],
    amount: totalVat,
    total,
  };
  if (recipient) invoice.recipient = recipient;

  if (isCorrective) {
    const corrected = Array.isArray(inv.correctedInvoices) ? inv.correctedInvoices : [];
    if (corrected.length === 0) {
      throw new MappingError(`invoice type ${type} requires correctedInvoices`);
    }
    invoice.creditNote = {
      style: "I", // por diferencias — Ops corrective is a difference note today
      ids: corrected.map((c) => {
        if (!c || !c.number || !isYmd(c.issuedDate)) {
          throw new MappingError("each correctedInvoices entry needs { number, issuedDate: YYYY-MM-DD }");
        }
        return { number: String(c.number), issuedTime: c.issuedDate };
      }),
    };
  }

  return { invoice };
}

module.exports = { buildAltaPayload, normalizeFiscalId, money, MappingError, MIN_ISSUE_DATE };
