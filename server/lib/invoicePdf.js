/**
 * Invoice PDF rendering — matches the real HITT invoice template (a sample
 * PDF, 2025-033, was provided directly by Alex as the reference to match).
 * Built with pdfkit (pure JS, no external binary/headless-browser needed).
 *
 * IMPORTANT: the entity letterhead block (legal name, address, VAT number,
 * email, website) is NOT stored anywhere in the database — confirmed by
 * inspecting invoicedocumentcontrols/invoicedocumenttext, which only hold
 * multi-language FIELD LABELS ("INVOICE NUMBER" / "FACTURA NUM"), not the
 * actual entity data (those rows are all NULL). The Access report must
 * have had this hardcoded in its own design. ENTITY_LETTERHEAD below has
 * confirmed real data for HiTT only (from the sample PDF); FHiTT and
 * HiTT/OSM fall back to the same block, which is almost certainly WRONG
 * for a different legal entity (different address/VAT at minimum) — do
 * not send an FHiTT or HiTT/OSM invoice PDF to a real client until
 * someone supplies their real letterhead details.
 */
const PDFDocument = require("pdfkit");

const BRAND = {
  ink: "#171717",
  teal: "#5C757C",
  cream: "#DAD4B2",
  border: "#CFC9B0",
  gray: "#5A5650",
  blue: "#2255AA",
};

const HITT_LETTERHEAD = {
  name: "Health Innovation Technology Transfer, SLU",
  addressLine1: "c/Aragó 60, pral. 1º",
  addressLine2: "E-08015 Barcelona",
  vat: "B-66540501",
  email: "invoices@hittbcn.com",
  web: "www.hittbcn.com",
  footer: "Health Innovation Technology Transfer, S.L.U., NIF B66540501, c/Aragó 60, pral.1, Barcelona, Spain\n" +
          "Inscripción en el Registro Mercantil de Barcelona. Tomo 44830, Folio 163, Hoja nº 468781",
};

// Same letterhead used for every entity until real FHiTT / HiTT-OSM legal
// details are supplied — see the file header note above.
const ENTITY_LETTERHEAD = {
  HiTT: HITT_LETTERHEAD,
  FHiTT: HITT_LETTERHEAD,
  "HiTT/OSM": HITT_LETTERHEAD,
};

function money(n, sym = "€") {
  const v = Number(n || 0);
  return `${sym}${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
// Access rich-text fields (descriptionservice/invoicecomments) come through
// as raw HTML (e.g. <div><font face=Arial size=1 color=black>text</font></div>)
// — strip markup down to plain text with paragraph breaks preserved.
function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/<\/(div|p|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .split("\n").map(line => line.trim()).join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function dateStr(d) {
  if (!d) return "";
  const dt = new Date(d);
  return `${String(dt.getUTCDate()).padStart(2, "0")}/${String(dt.getUTCMonth() + 1).padStart(2, "0")}/${dt.getUTCFullYear()}`;
}

// Labelled box: small caption above/beside a bordered value box.
function fieldBox(doc, x, y, w, label, value) {
  doc.font("Helvetica-Bold").fontSize(8).fillColor(BRAND.ink).text(label, x, y);
  doc.rect(x, y + 12, w, 16).stroke(BRAND.border);
  doc.font("Helvetica").fontSize(9).fillColor(BRAND.ink).text(value || "", x + 4, y + 16, { width: w - 8 });
}

function renderInvoicePdf(doc, data) {
  const letter = ENTITY_LETTERHEAD[data.entityLabel] || HITT_LETTERHEAD;
  const left = 40;
  const right = 555;
  const width = right - left;

  // ---------- Header: letterhead + contact ----------
  doc.font("Helvetica-Bold").fontSize(16).fillColor(BRAND.teal).text("HITT", left, 40);
  doc.font("Helvetica").fontSize(6).fillColor(BRAND.gray)
    .text("Health Innovation", left, 58)
    .text("Technology Transfer", left, 66);

  doc.font("Helvetica-Bold").fontSize(10).fillColor(BRAND.ink).text(letter.name, left, 90);
  doc.font("Helvetica").fontSize(9).fillColor(BRAND.ink)
    .text(letter.addressLine1, left, 104)
    .text(letter.addressLine2, left, 116)
    .text(letter.vat, left, 128);

  doc.font("Helvetica").fontSize(9).fillColor(BRAND.blue)
    .text(letter.email, right - 160, 90, { width: 160, align: "right", link: `mailto:${letter.email}` })
    .text(letter.web, right - 160, 102, { width: 160, align: "right", link: `https://${letter.web}` });

  // ---------- Invoice meta grid ----------
  const gridY = 160;
  const colW = width / 2 - 6;
  fieldBox(doc, left, gridY, colW, "INVOICE NUMBER", data.invoicecode || "(draft)");
  fieldBox(doc, left + colW + 12, gridY, colW, "DUE DATE", dateStr(data.invoiceduedate));
  fieldBox(doc, left, gridY + 34, colW, "INVOICE DATE", dateStr(data.invoicedate));
  fieldBox(doc, left + colW + 12, gridY + 34, colW, "PURCHASE ORDER", data.purchaseorder);
  fieldBox(doc, left, gridY + 68, colW, "INTERNAL PROJECT NUMBER", data.projectCode);
  fieldBox(doc, left + colW + 12, gridY + 68, colW, "OTHER REFERENCE", data.numocclient);

  // ---------- Invoice To ----------
  const toY = gridY + 112;
  doc.font("Helvetica-Bold").fontSize(8).fillColor(BRAND.ink).text("INVOICE TO", left, toY);
  doc.rect(left, toY + 14, width, 64).fillAndStroke(BRAND.cream, BRAND.border);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(BRAND.ink).text(data.taxCompanyName || "—", left + 8, toY + 22);
  doc.font("Helvetica").fontSize(9).fillColor(BRAND.ink);
  let tY = toY + 34;
  for (const line of [data.taxCompanyStreet, data.taxCompanyZipCity, data.taxCompanyVat].filter(Boolean)) {
    doc.text(line, left + 8, tY, { width: width - 16 });
    tY += 12;
  }

  // ---------- Line items ----------
  const sym = data.currencySymbol || "€";
  const tableY = toY + 100;
  const cols = { desc: left, units: left + 300, price: left + 350, total: left + 440 };
  doc.font("Helvetica-Bold").fontSize(9).fillColor(BRAND.ink)
    .text("Item/Services provided/Subject", cols.desc, tableY)
    .text("Units", cols.units, tableY)
    .text("Price per unit", cols.price, tableY)
    .text("Total", cols.total, tableY);
  doc.moveTo(left, tableY + 14).lineTo(right, tableY + 14).lineWidth(1.2).stroke(BRAND.ink);

  // Real line items when present; otherwise a single synthetic row from the
  // old free-text description + flat amount (legacy invoices).
  let items = Array.isArray(data.lineItems) ? data.lineItems : [];
  if (!items.length) {
    items = [{ description: stripHtml(data.descriptionservice), quantity: 1, unitPrice: Number(data.amount || 0) }];
  }

  let y = tableY + 14;
  doc.font("Helvetica").fontSize(9).fillColor(BRAND.ink);
  for (const li of items) {
    const desc = stripHtml(li.description) || "";
    const qty = Number(li.quantity || 0);
    const unit = Number(li.unitPrice || 0);
    const rowH = Math.max(doc.heightOfString(desc || " ", { width: 290 }), 12) + 8;
    doc.text(desc, cols.desc, y + 5, { width: 290 });
    doc.text(String(qty), cols.units, y + 5);
    doc.text(money(unit, sym), cols.price, y + 5);
    doc.text(money(qty * unit, sym), cols.total, y + 5);
    doc.rect(left, y, width, rowH).stroke(BRAND.border);
    y += rowH;
  }

  const subtotal = items.reduce((s, li) => s + Number(li.quantity || 0) * Number(li.unitPrice || 0), 0);

  // ---------- Totals ----------
  const totalsY = y + 20;
  const totalsX = right - 220;
  const vatPct = data.vatPercentage ?? 0;
  doc.font("Helvetica").fontSize(9).fillColor(BRAND.ink);
  doc.text("Total amount", totalsX, totalsY, { width: 120 });
  doc.text(money(subtotal, sym), totalsX + 120, totalsY, { width: 100, align: "right" });
  doc.text(`VAT ${vatPct}%`, totalsX, totalsY + 16, { width: 120 });
  doc.text(money(data.vatamount, sym), totalsX + 120, totalsY + 16, { width: 100, align: "right" });
  doc.rect(totalsX, totalsY + 32, 220, 20).fill(BRAND.cream);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(BRAND.ink);
  doc.text("INVOICE TOTAL", totalsX + 4, totalsY + 38, { width: 116 });
  doc.text(money(subtotal + Number(data.vatamount || 0), sym), totalsX + 120, totalsY + 38, { width: 96, align: "right" });

  // ---------- Bank details ----------
  const bankY = totalsY + 90;
  doc.font("Helvetica-Bold").fontSize(8).fillColor(BRAND.ink).text("BANK ACCOUNT NUMBER", left, bankY);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(BRAND.ink).text(data.bankName || "—", left, bankY + 14);
  doc.font("Helvetica").fontSize(9).fillColor(BRAND.ink);
  let bY = bankY + 26;
  for (const line of [data.bankAddressLine1, data.bankAddressLine2].filter(Boolean)) {
    doc.text(line, left, bY);
    bY += 12;
  }
  doc.font("Helvetica-Bold").fontSize(9).text(data.iban || "", left, bY + 2);
  doc.font("Helvetica").fontSize(9).text(data.bicSwift || "", left, bY + 14);
  doc.text(`When paying by bank transfer, please state invoice number ${data.invoicecode || ""}`, left, bY + 30);

  // ---------- Footer ----------
  const footerY = 780;
  doc.rect(left, footerY, width, 30).stroke(BRAND.blue);
  doc.font("Helvetica").fontSize(7).fillColor(BRAND.blue)
    .text(letter.footer, left + 6, footerY + 6, { width: width - 12, align: "center" });
}

function streamInvoicePdf(res, data) {
  const doc = new PDFDocument({ size: "A4", margin: 0 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${data.invoicecode || "invoice"}.pdf"`);
  doc.pipe(res);
  renderInvoicePdf(doc, data);
  doc.end();
}

module.exports = { streamInvoicePdf };
