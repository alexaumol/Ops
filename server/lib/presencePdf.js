/**
 * "Registro de jornada" PDF — the legal working-time record for one worker
 * over a period (RDL 8/2019, art. 34.9 ET). Built with pdfkit.
 *
 * Handed to the worker on request, to their legal representatives, and to
 * the Inspección de Trabajo. Deliberately plain and complete: every day in
 * the range on its own row, times in the org timezone, daily + period
 * totals, and a footer stating the legal basis and retention.
 */
const PDFDocument = require("pdfkit");

const INK = "#171717";
const GRAY = "#5A5650";
const LINE = "#CFC9B0";

function hm(min) {
  const sign = min < 0 ? "-" : "";
  const a = Math.abs(min);
  return `${sign}${Math.floor(a / 60)}h ${String(a % 60).padStart(2, "0")}m`;
}

const LOC_ES = { office: "Oficina", remote: "Teletrabajo", client: "Cliente" };
// The self-declared location for a day: the shared label across its
// segments, "varias" when they differ, "" when none was recorded.
function dayLocation(segments) {
  const set = [...new Set((segments || []).map((s) => s.location).filter(Boolean))];
  if (!set.length) return "";
  return set.length === 1 ? (LOC_ES[set[0]] || set[0]) : "varias";
}

function renderPresencePdf(doc, data) {
  const { name, from, to, timezone, generatedAt, days, totals, methodDoc } = data;
  const time = (iso) =>
    iso ? new Intl.DateTimeFormat("es-ES", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "—";
  const M = 40;
  const W = doc.page.width - M * 2;

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(15).text("Registro de jornada", M, M);
  doc.font("Helvetica").fontSize(9).fillColor(GRAY)
    .text(`Persona trabajadora: ${name}`, { continued: false })
    .text(`Periodo: ${from} a ${to}   ·   Zona horaria: ${timezone}`)
    .text(`Documento generado: ${new Intl.DateTimeFormat("es-ES", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(generatedAt)}`);
  doc.moveDown(0.8);

  // table header
  const cols = [
    { k: "date", w: 70, label: "Fecha" },
    { k: "in", w: 44, label: "Entrada" },
    { k: "out", w: 44, label: "Salida" },
    { k: "seg", w: 140, label: "Tramos" },
    { k: "loc", w: 64, label: "Ubicación" },
    { k: "worked", w: 56, label: "Trabajado" },
    { k: "expected", w: 56, label: "Previsto" },
    { k: "balance", w: 54, label: "Saldo" },
  ];
  let y = doc.y;
  const rowH = 15;
  const drawRow = (cells, opts = {}) => {
    if (y + rowH > doc.page.height - 70) { doc.addPage(); y = M; }
    let x = M;
    doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(7.5).fillColor(opts.color || INK);
    cols.forEach((c) => {
      doc.text(String(cells[c.k] ?? ""), x + 2, y + 3, { width: c.w - 4, ellipsis: true });
      x += c.w;
    });
    doc.moveTo(M, y + rowH).lineTo(M + W, y + rowH).strokeColor(LINE).lineWidth(0.5).stroke();
    y += rowH;
  };
  drawRow(Object.fromEntries(cols.map((c) => [c.k, c.label])), { bold: true });

  for (const d of days) {
    const obs = d.leave ? `· ${d.leave}` : d.holiday ? `· ${d.holiday}` : d.open ? "· en curso" : "";
    drawRow({
      date: d.date + (d.hasManual ? " *" : ""),
      in: time(d.firstIn),
      out: time(d.lastOut),
      seg: (d.segments.map((s) => `${time(s.in)}–${time(s.out)}`).join("  ") || obs).slice(0, 60),
      loc: dayLocation(d.segments),
      worked: hm(d.workedMinutes),
      expected: hm(d.expectedMinutes),
      balance: hm(d.balanceMinutes),
    }, { color: d.balanceMinutes < 0 ? "#B24A3A" : INK });
  }
  drawRow({
    date: "TOTAL", in: "", out: "", seg: "", loc: "",
    worked: hm(totals.workedMinutes), expected: hm(totals.expectedMinutes), balance: hm(totals.balanceMinutes),
  }, { bold: true });

  doc.moveDown(1.2);
  doc.font("Helvetica").fontSize(7).fillColor(GRAY).text(
    "* Día con al menos un fichaje introducido o corregido manualmente (con motivo registrado y trazabilidad conforme al art. 34.9 ET). " +
    "Los fichajes originales se conservan íntegros; una corrección es un asiento nuevo que sustituye al anterior. " +
    "Registro conservado durante cuatro años y a disposición de la persona trabajadora, sus representantes legales y la Inspección de Trabajo y Seguridad Social (RDL 8/2019).",
    M, doc.y, { width: W }
  );
  if (methodDoc) {
    doc.moveDown(0.4);
    doc.text(`Sistema de registro acordado: ${methodDoc}`, { width: W });
  }
}

function streamPresencePdf(res, data) {
  const doc = new PDFDocument({ size: "A4", margin: 0 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="registro-jornada_${String(data.name || "").replace(/[^\w-]+/g, "_")}_${data.from}_${data.to}.pdf"`
  );
  doc.pipe(res);
  renderPresencePdf(doc, data);
  doc.end();
}

module.exports = { streamPresencePdf, renderPresencePdf };
