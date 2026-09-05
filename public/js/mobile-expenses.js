/**
 * HITT Ops — Mobile expense capture
 * ---------------------------------------------------------------------------
 * Phone-first single-task screen: photograph a paper receipt, fill in the
 * basics, bind it to a project. Posts to the same /api/expenses used by the
 * desktop Expenses page (server/routes/expenses.js) — this is just a second,
 * lighter-weight UI in front of the same data, with the project picker
 * pre-filtered server-side to alive projects the signed-in employee is
 * actually assigned to (GET /api/expenses/my-projects); an admin sees every
 * alive project instead, same as the desktop side panel's "Alive" toggle.
 * ---------------------------------------------------------------------------
 */
const session = HITT_AUTH.requireSession("../index.html");
HITT_PERMS.guardModule("expenses", "../welcome.html");
const T = (k, v) => (window.HITT_I18N ? HITT_I18N.t(k, v) : k);
HITT_PERMS.applyRealName();

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; }
function toast(msg, tone = "navy") {
  const host = document.getElementById("toastHost");
  const el = document.createElement("div");
  el.className = `toast toast-${tone}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

let CATEGORIES = [];
let PROJECTS = [];

function categoryOptions(selectedId) {
  return `<option value="">${T("exp.noneOption")}</option>` +
    CATEGORIES.map((c) => `<option value="${c.id}" ${String(c.id) === String(selectedId) ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("");
}
function projectOptions(selectedId) {
  return `<option value="">${T("exp.pickProject")}</option>` +
    PROJECTS.map((p) => `<option value="${p.id}" ${String(p.id) === String(selectedId) ? "selected" : ""}>${escapeHtml(p.code)} — ${escapeHtml(p.name)}</option>`).join("");
}

/* ============================== Project / internal toggle ============= */
const internalCheckbox = document.getElementById("mxInternal");
const projectField = document.getElementById("mxProjectField");
const invoiceableRow = document.getElementById("mxInvoiceableRow");
function syncProjectField() {
  const internal = internalCheckbox.checked;
  projectField.style.display = internal ? "none" : "";
  invoiceableRow.style.display = internal ? "none" : "";
}
internalCheckbox.addEventListener("change", syncProjectField);

/* ============================== Photo capture ========================== */
const dropEl = document.getElementById("mxPhotoDrop");
const previewEl = document.getElementById("mxPhotoPreview");
const imgEl = document.getElementById("mxPhotoImg");
const pdfEl = document.getElementById("mxPhotoPdf");
const pdfNameEl = document.getElementById("mxPhotoPdfName");
const noPreviewEl = document.getElementById("mxPhotoNoPreview");
const noPreviewNameEl = document.getElementById("mxPhotoNoPreviewName");
const cameraInput = document.getElementById("mxFileCamera");
const galleryInput = document.getElementById("mxFileGallery");
let selectedFile = null;

document.getElementById("mxTakePhoto").addEventListener("click", () => cameraInput.click());
document.getElementById("mxChooseFile").addEventListener("click", () => galleryInput.click());
document.getElementById("mxRetake").addEventListener("click", () => {
  clearPhoto();
  dropEl.classList.remove("hidden");
  previewEl.classList.add("hidden");
});

// A phone camera photo easily runs 8-20+ MB at 12-50 megapixels — well past
// the server's 15 MB evidence-upload cap (server/routes/expenses.js) and
// slow over cellular data for what's just a receipt.
//
// This deliberately uses createImageBitmap's resize option rather than the
// more obvious new Image() + canvas approach: decoding a large photo into
// an <img>/Image first materializes its FULL-resolution pixel buffer in
// memory before anything gets scaled down (a 48 MP photo is ~180 MB of raw
// RGBA) — that's exactly what was crashing mobile browsers with an
// "insufficient memory" error right after taking the photo. Asking
// createImageBitmap to resize during decode lets the browser use a scaled
// decode (e.g. JPEG's DCT-based downscaling), so the full-resolution buffer
// is never allocated at all. Falls back to the original file, untouched, if
// anything here fails or isn't supported — a photo should never be
// silently dropped by a client-side optimization.
async function compressImage(file, { maxDim = 1600, quality = 0.82 } = {}) {
  if (!/^image\//.test(file.type) || typeof createImageBitmap !== "function") return file;
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file, { resizeWidth: maxDim, resizeQuality: "medium" });
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob || blob.size >= file.size) return file;
    const name = (file.name || "receipt").replace(/\.\w+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
  } catch (err) {
    console.warn("[mobile-expenses] photo compression skipped:", err?.message || err);
    return file;
  } finally {
    if (bitmap) bitmap.close();
  }
}

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

async function handleFile(file) {
  if (!file) return;
  dropEl.classList.add("hidden");
  previewEl.classList.remove("hidden");
  noPreviewEl.classList.add("hidden");
  // "Choose file" hands back whatever the device's file/photo picker gives
  // it — unlike a fresh camera capture, that can be a PDF with a generic
  // MIME type from some document providers, so don't rely on file.type
  // alone.
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
  if (isPdf) {
    selectedFile = file;
    imgEl.classList.add("hidden");
    pdfEl.classList.remove("hidden");
    pdfNameEl.textContent = file.name;
    return;
  }
  pdfEl.classList.add("hidden");
  imgEl.classList.remove("hidden");
  if (imgEl.src) URL.revokeObjectURL(imgEl.src);
  // A photo picked from the gallery (as opposed to a fresh camera capture)
  // can be in a format the <img> tag can't render on this browser — most
  // commonly a HEIC/HEIF photo straight from an iPhone's library, which
  // isn't transcoded to JPEG the way a live camera capture is. The photo is
  // still attached and will still upload fine either way (or gets
  // re-encoded to JPEG below if the browser CAN decode it) — this only
  // covers the on-screen preview failing, so show a clear fallback instead
  // of a blank/broken image.
  imgEl.onerror = () => {
    imgEl.classList.add("hidden");
    noPreviewEl.classList.remove("hidden");
    noPreviewNameEl.textContent = file.name || "";
  };
  imgEl.src = URL.createObjectURL(file); // preview the original right away — no need to wait on compression
  selectedFile = await compressImage(file);
}
function clearPhoto() {
  selectedFile = null;
  cameraInput.value = "";
  galleryInput.value = "";
  if (imgEl.src) { URL.revokeObjectURL(imgEl.src); imgEl.src = ""; }
  imgEl.onerror = null;
  noPreviewEl.classList.add("hidden");
}
cameraInput.addEventListener("change", () => handleFile(cameraInput.files[0]));
galleryInput.addEventListener("change", () => handleFile(galleryInput.files[0]));

/* ============================== Save =================================== */
function todayIso() { return new Date().toISOString().slice(0, 10); }

// Clears the fields worth re-filling for the next receipt, but leaves date,
// category, project and internal/re-invoiceable as they were — someone
// photographing a stack of tickets from the same trip usually wants those
// to carry over.
function resetForAnother() {
  document.getElementById("mxDescription").value = "";
  document.getElementById("mxAmount").value = "";
  clearPhoto();
  dropEl.classList.remove("hidden");
  previewEl.classList.add("hidden");
}

document.getElementById("mxSave").addEventListener("click", async () => {
  const amount = document.getElementById("mxAmount").value;
  if (amount === "" || Number.isNaN(Number(amount))) { toast(T("exp.toast.enterAmount"), "red"); return; }
  if (selectedFile && selectedFile.size > MAX_UPLOAD_BYTES) { toast(T("mx.photo.tooLarge"), "red"); return; }
  const internal = internalCheckbox.checked;

  const fields = {
    expenseDate: document.getElementById("mxDate").value || "",
    categoryId: document.getElementById("mxCategory").value || "",
    description: document.getElementById("mxDescription").value.trim(),
    amount,
    isInternal: internal ? "true" : "false",
    projectId: internal ? "" : (document.getElementById("mxProject").value || ""),
    invoiceable: (!internal && document.getElementById("mxInvoiceable").checked) ? "true" : "false",
    // paidBy deliberately omitted — the server defaults it to the signed-in
    // employee (see expenseBody() in server/routes/expenses.js).
  };
  let payload;
  if (selectedFile) {
    payload = new FormData();
    Object.entries(fields).forEach(([k, v]) => payload.set(k, v));
    payload.set("document", selectedFile);
  } else {
    payload = fields;
  }

  const btn = document.getElementById("mxSave");
  btn.disabled = true;
  try {
    await HITT_API.createExpense(payload);
    toast(T("exp.toast.added"), "green");
    resetForAnother();
  } catch (err) {
    toast(err.message || T("exp.toast.saveFail"), "red");
  } finally {
    btn.disabled = false;
  }
});

/* ============================== Init ==================================== */
(async () => {
  document.getElementById("mxDate").value = todayIso();

  const [perms, cats, myProjects] = await Promise.allSettled([
    HITT_PERMS.get(),
    HITT_API.getExpenseCategories(),
    HITT_API.getExpenseMyProjects(),
  ]);

  if (cats.status === "fulfilled") {
    CATEGORIES = cats.value || [];
    document.getElementById("mxCategory").innerHTML = categoryOptions(null);
  }

  const isAdmin = perms.status === "fulfilled" && !!perms.value?.isAdmin;
  const hintEl = document.getElementById("mxProjectHint");
  if (myProjects.status === "fulfilled") {
    PROJECTS = (myProjects.value?.rows || [])
      .sort((a, b) => String(b.code).localeCompare(String(a.code), undefined, { numeric: true }));
    document.getElementById("mxProject").innerHTML = projectOptions(null);
    if (!PROJECTS.length) {
      hintEl.textContent = T("mx.project.empty");
      hintEl.classList.add("mx-hint--warn");
    } else {
      hintEl.textContent = T(isAdmin ? "mx.project.allAdmin" : "mx.project.mine");
    }
  } else {
    hintEl.textContent = T("mx.project.loadFail");
    hintEl.classList.add("mx-hint--warn");
  }

  syncProjectField();
})();

/* Re-render dynamic content when the UI language changes. */
window.addEventListener("hitt:langchange", () => {
  document.getElementById("mxCategory").innerHTML = categoryOptions(document.getElementById("mxCategory").value);
  document.getElementById("mxProject").innerHTML = projectOptions(document.getElementById("mxProject").value);
});
