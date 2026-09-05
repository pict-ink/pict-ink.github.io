(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const canvas = $("previewCanvas"), ctx = canvas.getContext("2d", { alpha: true });
  const state = { assets: [], active: -1, zoom: 0, history: [], future: [], renderToken: 0 };
  const adjustmentIds = ["brightness", "contrast", "saturation", "warmth", "blur"];
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
  let toastTimer;

  function defaultEdit(image) {
    return { rotation: 0, flipX: false, flipY: false, crop: { x: 0, y: 0, width: image.width, height: image.height }, brightness: 0, contrast: 0, saturation: 0, warmth: 0, blur: 0 };
  }
  function activeAsset() { return state.assets[state.active]; }
  function snapshot() { const a = activeAsset(); return a ? JSON.stringify(a.edit) : ""; }
  function pushHistory(before) {
    if (!activeAsset() || before === snapshot()) return;
    state.history.push(before); if (state.history.length > 60) state.history.shift();
    state.future = []; updateHistoryButtons();
  }
  function updateHistoryButtons() { $("undoButton").disabled = !state.history.length; $("redoButton").disabled = !state.future.length; }
  function showToast(message) { $("toast").textContent = message; $("toast").classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2200); }
  function cleanName(name) { return name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "image"; }
  function formatBytes(bytes) { if (bytes < 1024) return bytes + " B"; if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB"; return (bytes / 1048576).toFixed(1) + " MB"; }

  async function loadFiles(files) {
    const images = [...files].filter(file => file.type.startsWith("image/"));
    if (!images.length) return showToast("Choose a supported image file");
    for (const file of images) {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        state.assets.push({ file, image: bitmap, url: URL.createObjectURL(file), edit: defaultEdit(bitmap) });
      } catch { showToast("Could not open " + file.name); }
    }
    if (state.active < 0 && state.assets.length) {
      $("emptyState").hidden = true; $("editor").hidden = false; selectAsset(0);
    } else { renderAssets(); }
  }
  function renderAssets() {
    $("assetList").replaceChildren(...state.assets.map((asset, index) => {
      const button = document.createElement("button"); button.className = "asset-item" + (index === state.active ? " active" : ""); button.type = "button";
      const img = document.createElement("img"); img.className = "asset-thumb"; img.src = asset.url; img.alt = "";
      const meta = document.createElement("span"); meta.className = "asset-meta";
      const name = document.createElement("span"); name.className = "asset-name"; name.textContent = asset.file.name;
      const size = document.createElement("span"); size.className = "asset-size"; size.textContent = asset.image.width + " × " + asset.image.height;
      meta.append(name, size); button.append(img, meta); button.addEventListener("click", () => selectAsset(index)); return button;
    }));
  }
  function selectAsset(index) {
    state.active = index; state.history = []; state.future = []; state.zoom = 0; renderAssets(); syncControls(); updateHistoryButtons(); render();
  }
  function syncControls() {
    const a = activeAsset(); if (!a) return; const e = a.edit;
    ["cropX", "cropY", "cropWidth", "cropHeight"].forEach((id, i) => $(id).value = Math.round([e.crop.x, e.crop.y, e.crop.width, e.crop.height][i]));
    adjustmentIds.forEach(id => { $(id).value = e[id]; $(id + "Value").value = e[id]; });
    $("exportName").value = cleanName(a.file.name); $("exportWidth").value = Math.round(e.crop.width); $("exportHeight").value = Math.round(e.crop.height); updateMarkup();
  }
  function filterString(e) { return `brightness(${100 + e.brightness}%) contrast(${100 + e.contrast}%) saturate(${100 + e.saturation}%) blur(${e.blur}px)`; }
  function renderTo(target, width, height) {
    const a = activeAsset(), e = a.edit, c = e.crop; target.width = width; target.height = height;
    const t = target.getContext("2d"); t.clearRect(0, 0, width, height); t.save(); t.filter = filterString(e);
    t.translate(width / 2, height / 2); t.scale(e.flipX ? -1 : 1, e.flipY ? -1 : 1); t.rotate(e.rotation * Math.PI / 180);
    const quarter = Math.abs(e.rotation % 180) === 90, dw = quarter ? height : width, dh = quarter ? width : height;
    t.drawImage(a.image, c.x, c.y, c.width, c.height, -dw / 2, -dh / 2, dw, dh); t.restore();
    if (e.warmth) { t.save(); t.globalCompositeOperation = e.warmth > 0 ? "screen" : "multiply"; t.globalAlpha = Math.abs(e.warmth) / 500; t.fillStyle = e.warmth > 0 ? "#ff9a45" : "#5588ff"; t.fillRect(0, 0, width, height); t.restore(); }
  }
  function render() {
    const a = activeAsset(); if (!a) return; const c = a.edit.crop, stage = $("canvasStage"), rotated = Math.abs(a.edit.rotation % 180) === 90;
    const sourceW = rotated ? c.height : c.width, sourceH = rotated ? c.width : c.height;
    const fit = Math.min((stage.clientWidth - 70) / sourceW, (stage.clientHeight - 70) / sourceH, 1);
    const scale = state.zoom || Math.max(.02, fit), width = Math.max(1, Math.round(sourceW * scale)), height = Math.max(1, Math.round(sourceH * scale));
    renderTo(canvas, width, height); $("zoomOutput").value = state.zoom ? Math.round(scale * 100) + "%" : "Fit";
    $("sourceInfo").textContent = a.file.name + " · " + a.image.width + " × " + a.image.height + " · " + formatBytes(a.file.size);
    $("editedInfo").textContent = Math.round(c.width) + " × " + Math.round(c.height);
  }
  function mutate(change) { const before = snapshot(); change(activeAsset().edit); pushHistory(before); syncControls(); render(); }
  function undo() { if (!state.history.length) return; state.future.push(snapshot()); activeAsset().edit = JSON.parse(state.history.pop()); syncControls(); render(); updateHistoryButtons(); }
  function redo() { if (!state.future.length) return; state.history.push(snapshot()); activeAsset().edit = JSON.parse(state.future.pop()); syncControls(); render(); updateHistoryButtons(); }
  function validCrop() {
    const a = activeAsset(), values = ["cropX", "cropY", "cropWidth", "cropHeight"].map(id => Number($(id).value));
    if (values.some(v => !Number.isFinite(v)) || values[2] < 1 || values[3] < 1) return null;
    return { x: Math.max(0, Math.min(values[0], a.image.width - 1)), y: Math.max(0, Math.min(values[1], a.image.height - 1)), width: Math.max(1, Math.min(values[2], a.image.width - values[0])), height: Math.max(1, Math.min(values[3], a.image.height - values[1])) };
  }
  function updateMarkup() {
    if (!activeAsset()) return; const name = cleanName($("exportName").value), ext = extension[$("exportFormat").value] || "webp";
    const widths = [...document.querySelectorAll("[name=variant]:checked")].map(x => +x.value).filter(w => w <= activeAsset().edit.crop.width);
    $("markupOutput").value = widths.length ? `<img src="${name}-${widths[0]}w.${ext}"\n  srcset="${widths.map(w => `${name}-${w}w.${ext} ${w}w`).join(", ")}"\n  sizes="100vw" alt="">` : "Select at least one output width.";
  }
  function outputDimensions(width) { const c = activeAsset().edit.crop; return [Math.round(width), Math.max(1, Math.round(width * c.height / c.width))]; }
  function canvasBlob(outputCanvas, type, quality) { return new Promise(resolve => outputCanvas.toBlob(resolve, type, quality)); }
  function download(blob, name) { const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  async function makeExport(width, height) {
    const out = document.createElement("canvas"); renderTo(out, width, height);
    return canvasBlob(out, $("exportFormat").value, +$("quality").value / 100);
  }
  async function exportImage() {
    const width = Math.max(1, +$("exportWidth").value), height = Math.max(1, +$("exportHeight").value); $("exportButton").disabled = true;
    try { const blob = await makeExport(width, height); if (!blob) throw new Error(); $("estimatedSize").textContent = formatBytes(blob.size); download(blob, cleanName($("exportName").value) + "." + extension[$("exportFormat").value]); showToast("Image exported"); }
    catch { showToast("This browser could not encode that format"); } finally { $("exportButton").disabled = false; }
  }
  async function exportVariants() {
    const c = activeAsset().edit.crop, widths = [...document.querySelectorAll("[name=variant]:checked")].map(x => +x.value).filter(w => w <= c.width);
    if (!widths.length) return showToast("Select a width no larger than the crop");
    $("variantsButton").disabled = true; let done = 0;
    for (const width of widths) { const [w, h] = outputDimensions(width), blob = await makeExport(w, h); if (blob) { download(blob, `${cleanName($("exportName").value)}-${w}w.${extension[$("exportFormat").value]}`); done++; await new Promise(r => setTimeout(r, 120)); } }
    $("variantsButton").disabled = false; updateMarkup(); showToast(done + (done === 1 ? " variant downloaded" : " variants downloaded"));
  }

  ["openButton", "emptyOpenButton", "addButton"].forEach(id => $(id).addEventListener("click", () => $("fileInput").click()));
  $("fileInput").addEventListener("change", e => { loadFiles(e.target.files); e.target.value = ""; });
  document.addEventListener("paste", e => loadFiles([...e.clipboardData.items].filter(i => i.kind === "file").map(i => i.getAsFile())));
  ["dragenter", "dragover"].forEach(type => document.addEventListener(type, e => { e.preventDefault(); if (!$("editor").hidden) $("canvasStage").classList.add("dragging"); }));
  ["dragleave", "drop"].forEach(type => document.addEventListener(type, e => { e.preventDefault(); $("canvasStage").classList.remove("dragging"); }));
  document.addEventListener("drop", e => loadFiles(e.dataTransfer.files));
  document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => { document.querySelectorAll(".tab").forEach(t => { const active = t === tab; t.classList.toggle("active", active); t.setAttribute("aria-selected", active); }); $("editPanel").hidden = tab.dataset.tab !== "edit"; $("exportPanel").hidden = tab.dataset.tab !== "export"; }));
  $("undoButton").addEventListener("click", undo); $("redoButton").addEventListener("click", redo);
  $("resetButton").addEventListener("click", () => mutate(() => activeAsset().edit = defaultEdit(activeAsset().image)));
  $("rotateLeft").addEventListener("click", () => mutate(e => e.rotation = (e.rotation + 270) % 360));
  $("rotateRight").addEventListener("click", () => mutate(e => e.rotation = (e.rotation + 90) % 360));
  $("flipHorizontal").addEventListener("click", () => mutate(e => e.flipX = !e.flipX));
  $("flipVertical").addEventListener("click", () => mutate(e => e.flipY = !e.flipY));
  $("resetCrop").addEventListener("click", () => mutate(e => e.crop = { x: 0, y: 0, width: activeAsset().image.width, height: activeAsset().image.height }));
  ["cropX", "cropY", "cropWidth", "cropHeight"].forEach(id => $(id).addEventListener("change", () => { const crop = validCrop(); if (crop) mutate(e => e.crop = crop); }));
  $("applyAspect").addEventListener("click", () => { const ratio = +$("aspectRatio").value; if (!ratio) return; mutate(e => { const image = activeAsset().image; let w = image.width, h = w / ratio; if (h > image.height) { h = image.height; w = h * ratio; } e.crop = { x: (image.width - w) / 2, y: (image.height - h) / 2, width: w, height: h }; }); });
  adjustmentIds.forEach(id => { let before; const remember = () => { if (before === undefined) before = snapshot(); }; $(id).addEventListener("pointerdown", () => before = snapshot()); $(id).addEventListener("keydown", remember); $(id).addEventListener("input", () => { remember(); activeAsset().edit[id] = +$(id).value; $(id + "Value").value = $(id).value; render(); }); $(id).addEventListener("change", () => { pushHistory(before); before = undefined; syncControls(); }); });
  $("resetAdjustments").addEventListener("click", () => mutate(e => adjustmentIds.forEach(id => e[id] = 0)));
  $("zoomIn").addEventListener("click", () => { state.zoom = Math.min(4, (state.zoom || canvas.width / activeAsset().edit.crop.width) * 1.25); render(); });
  $("zoomOut").addEventListener("click", () => { state.zoom = Math.max(.05, (state.zoom || canvas.width / activeAsset().edit.crop.width) / 1.25); render(); });
  $("exportWidth").addEventListener("change", () => { if ($("lockRatio").checked) $("exportHeight").value = outputDimensions(+$("exportWidth").value)[1]; });
  $("exportHeight").addEventListener("change", () => { if ($("lockRatio").checked) $("exportWidth").value = Math.round(+$("exportHeight").value * activeAsset().edit.crop.width / activeAsset().edit.crop.height); });
  $("exportFormat").addEventListener("change", () => { $("qualityLabel").hidden = $("exportFormat").value === "image/png"; updateMarkup(); });
  $("quality").addEventListener("input", () => $("qualityValue").value = $("quality").value);
  $("exportName").addEventListener("input", updateMarkup); document.querySelectorAll("[name=variant]").forEach(x => x.addEventListener("change", updateMarkup));
  $("exportButton").addEventListener("click", exportImage); $("variantsButton").addEventListener("click", exportVariants);
  $("copyMarkup").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("markupOutput").value); showToast("Markup copied"); } catch { $("markupOutput").select(); document.execCommand("copy"); showToast("Markup copied"); } });
  window.addEventListener("resize", () => { if (activeAsset() && !state.zoom) render(); });
  document.addEventListener("keydown", e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); } });
})();
