/**
 * Invoice PDF rendering — layout matched to a real reference invoice
 * (sample 2025-033). Built with pdfkit (pure JS, no external binary /
 * headless-browser needed).
 *
 * Letterhead + bank + logo come entirely from the entity record (Settings →
 * Entities — legal name / VAT / address / invoicing email / webpage / bank
 * account / invoice logo), passed in on `data` by routes/invoicing.js
 * (loadInvoiceForPdf). Nothing about the issuing company is hardcoded — a
 * blank field renders blank rather than borrowing another entity's details.
 *
 * Field LABELS ("INVOICE NUMBER" / "FACTURA NUM") come from
 * invoicedocumentcontrols/invoicedocumenttext in the business partner's
 * language (see lib/invoiceDocText.js + data.labels).
 *
 * Header logo priority: the entity's own invoice logo (data.entityLogo,
 * PNG/JPEG data URL) → a plain text mark from the entity name.
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

// Parses "data:image/png;base64,AAAA" -> Buffer (pdfkit only takes PNG/JPEG).
function dataUrlToBuffer(dataUrl) {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/s.exec(String(dataUrl || "").trim());
  if (!m) return null;
  try { return Buffer.from(m[2].replace(/\s+/g, ""), "base64"); } catch { return null; }
}

// Letterhead for the invoice — entirely from the entity record (Settings →
// Entities). Missing fields render blank; nothing is borrowed from another
// entity or hardcoded.
function entityLetterhead(data) {
  const addr = (data.entityAddress || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const name = data.entityLegalName || data.entityLabel || "";
  const vat = data.entityVat || "";
  const footer = [name, vat && `NIF ${vat}`, addr.join(", ")].filter(Boolean).join(", ");
  return {
    name,
    addressLines: addr,
    vat,
    email: data.entityEmail || "",
    web: data.entityWeb || "",
    footer,
    logo: dataUrlToBuffer(data.entityLogo),
  };
}

function renderInvoicePdf(doc, data) {
  const letter = entityLetterhead(data);
  const left = 40;
  const right = 555;
  const width = right - left;

  // Field labels in the business partner's language (invoicedocumentcontrols
  // / invoicedocumenttext) — English, then the hardcoded fallback here.
  const L = (controlname, fallback) =>
    (data.labels && typeof data.labels.get === "function" ? data.labels.get(controlname, fallback) : fallback);
  // Access stores the VAT label with the rate baked in ("VAT 21%" / "IVA 21%")
  // — take just the word so the rate stays dynamic.
  const vatWord = String(L("lblVATAmount", "VAT")).replace(/[\s\d.,%]+$/, "").trim() || "VAT";

  // ---------- Header: letterhead + contact ----------
  // Entity's own invoice logo (Settings → Entities) wins; else a plain text
  // mark from the entity name.
  let logoDrawn = false;
  if (letter.logo) {
    try {
      doc.image(letter.logo, left, 40, { height: 42 });
      logoDrawn = true;
    } catch (err) {
      console.error("[invoicePdf] could not embed the entity logo:", err.message);
    }
  }
  if (!logoDrawn) {
    const mark = (data.entityLabel || letter.name || "").trim();
    if (mark) {
      doc.font("Helvetica-Bold").fontSize(16).fillColor(BRAND.teal).text(mark.slice(0, 40), left, 40);
    }
  }

  doc.font("Helvetica-Bold").fontSize(10).fillColor(BRAND.ink).text(letter.name, left, 90);
  doc.font("Helvetica").fontSize(9).fillColor(BRAND.ink);
  let ly = 104;
  for (const line of letter.addressLines.slice(0, 3)) {
    doc.text(line, left, ly, { width: 260 });
    ly += 12;
  }
  if (letter.vat) doc.text(letter.vat, left, ly);

  doc.font("Helvetica").fontSize(9).fillColor(BRAND.blue);
  if (letter.email) doc.text(letter.email, right - 160, 90, { width: 160, align: "right", link: `mailto:${letter.email}` });
  if (letter.web) doc.text(letter.web, right - 160, 102, { width: 160, align: "right", link: `https://${letter.web.replace(/^https?:\/\//, "")}` });

  // ---------- Invoice meta grid ----------
  const gridY = 160;
  const colW = width / 2 - 6;
  fieldBox(doc, left, gridY, colW, L("lblInvoiceCode", "INVOICE NUMBER"), data.invoicecode || "(draft)");
  fieldBox(doc, left + colW + 12, gridY, colW, L("lblInvoiceDueDate", "DUE DATE"), dateStr(data.invoiceduedate));
  fieldBox(doc, left, gridY + 34, colW, L("lblInvoiceDate", "INVOICE DATE"), dateStr(data.invoicedate));
  fieldBox(doc, left + colW + 12, gridY + 34, colW, L("lblPurchaseOrder", "PURCHASE ORDER"), data.purchaseorder);
  fieldBox(doc, left, gridY + 68, colW, L("lblProjectCode", "INTERNAL PROJECT NUMBER"), data.projectCode);
  fieldBox(doc, left + colW + 12, gridY + 68, colW, "OTHER REFERENCE", data.numocclient);

  // ---------- Invoice To ----------
  const toY = gridY + 112;
  doc.font("Helvetica-Bold").fontSize(8).fillColor(BRAND.ink).text(L("txtInvoiceDataHeader", "INVOICE TO"), left, toY);
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
    .text(L("lblHeaderDescService", "Item/Services provided/Subject"), cols.desc, tableY)
    .text(L("lblUnitQty", "Units"), cols.units, tableY)
    .text(L("lblPriceUnit", "Price per unit"), cols.price, tableY)
    .text(L("lblPriceTotal", "Total"), cols.total, tableY);
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
  doc.text(L("lblAmount", "Total amount"), totalsX, totalsY, { width: 120 });
  doc.text(money(subtotal, sym), totalsX + 120, totalsY, { width: 100, align: "right" });
  doc.text(`${vatWord} ${vatPct}%`, totalsX, totalsY + 16, { width: 120 });
  doc.text(money(data.vatamount, sym), totalsX + 120, totalsY + 16, { width: 100, align: "right" });
  doc.rect(totalsX, totalsY + 32, 220, 20).fill(BRAND.cream);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(BRAND.ink);
  doc.text(L("lblTotal", "INVOICE TOTAL"), totalsX + 4, totalsY + 38, { width: 116 });
  doc.text(money(subtotal + Number(data.vatamount || 0), sym), totalsX + 120, totalsY + 38, { width: 96, align: "right" });

  // ---------- Bank details ----------
  // VAT-exemption note (localised) — only when nothing is being charged.
  if (!Number(data.vatamount) && Number(vatPct) === 0) {
    doc.font("Helvetica-Oblique").fontSize(8).fillColor(BRAND.gray)
      .text(L("txtVATExemption",
        "Exempt from VAT pursuant to Article 20.1-9 of Law 37/1992 of 28 December 1992 on Value Added Tax"),
        left, totalsY + 6, { width: totalsX - left - 12 });
  }

  const bankY = totalsY + 90;
  doc.font("Helvetica-Bold").fontSize(8).fillColor(BRAND.ink).text(L("txtBankDetailsHeader", "BANK ACCOUNT NUMBER"), left, bankY);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(BRAND.ink).text(data.bankName || "—", left, bankY + 14);
  doc.font("Helvetica").fontSize(9).fillColor(BRAND.ink);
  let bY = bankY + 26;
  for (const line of [data.bankAddressLine1, data.bankAddressLine2].filter(Boolean)) {
    doc.text(line, left, bY);
    bY += 12;
  }
  doc.font("Helvetica-Bold").fontSize(9).text(data.iban || "", left, bY + 2);
  doc.font("Helvetica").fontSize(9).text(data.bicSwift || "", left, bY + 14);
  doc.text(`${L("txtDipositInfo", "When paying by bank transfer, please state invoice number")} ${data.invoicecode || ""}`, left, bY + 30);

  // ---------- Veri*Factu QR + legend (Spain) ----------
  // Rendered from the stored AEAT registration record (data.verifactuQr /
  // data.verifactuUrl). Absent on a non-Spanish instance or a draft.
  renderVerifactuBlock(doc, data, { left, right, width, L });

  // ---------- Footer ----------
  if (letter.footer) {
    const footerY = 780;
    doc.rect(left, footerY, width, 30).stroke(BRAND.blue);
    doc.font("Helvetica").fontSize(7).fillColor(BRAND.blue)
      .text(letter.footer, left + 6, footerY + 6, { width: width - 12, align: "center" });
  }
}

// Bottom-left QR + the "verifiable invoice" legend the Reglamento requires
// on a Veri*Factu invoice. No-op when the invoice carries no QR.
function renderVerifactuBlock(doc, data, { left, right, L }) {
  const qr = dataUrlToBuffer(data.verifactuQr);
  const url = data.verifactuUrl || "";
  if (!qr && !url) return;

  const y = 690;
  const qrSize = 74;
  let textX = left;
  if (qr) {
    try {
      doc.image(qr, left, y, { width: qrSize, height: qrSize });
      textX = left + qrSize + 10;
    } catch {
      /* unreadable QR data — fall through to the text-only legend */
    }
  }

  const legend = L(
    "txtVerifactuLegend",
    "Factura verificable en la Sede Electrónica de la AEAT o en la app «Comprueba»."
  );
  doc.font("Helvetica-Bold").fontSize(8).fillColor(BRAND.ink)
    .text("VERI*FACTU", textX, y, { width: right - textX });
  doc.font("Helvetica").fontSize(7.5).fillColor(BRAND.gray)
    .text(legend, textX, y + 12, { width: right - textX });
  if (url) {
    doc.fontSize(6.5).fillColor(BRAND.blue)
      .text(url, textX, y + 12 + doc.heightOfString(legend, { width: right - textX }) + 3, {
        width: right - textX,
        link: url,
      });
  }
}

function streamInvoicePdf(res, data) {
  const doc = new PDFDocument({ size: "A4", margin: 0 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${data.invoicecode || "invoice"}.pdf"`);
  doc.pipe(res);
  renderInvoicePdf(doc, data);
  doc.end();
}

// Same render, collected into a Buffer — for attaching the PDF to an email.
function renderInvoicePdfBuffer(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 0 });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      renderInvoicePdf(doc, data);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { streamInvoicePdf, renderInvoicePdfBuffer };
