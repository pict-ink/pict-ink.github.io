(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const canvas = $("previewCanvas"), interactionCanvas = $("interactionCanvas");
  const state = { assets: [], active: -1, zoom: 0, history: [], future: [], tool: "select", gesture: null };
  const adjustmentIds = ["brightness", "contrast", "saturation", "warmth", "blur"];
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
  let toastTimer;

  function defaultEdit(image) {
    return { rotation: 0, flipX: false, flipY: false, crop: { x: 0, y: 0, width: image.width, height: image.height }, brightness: 0, contrast: 0, saturation: 0, warmth: 0, blur: 0 };
  }
  function activeAsset() { return state.assets[state.active]; }
  function snapshot() {
    const a = activeAsset(); if (!a) return null;
    return { edit: JSON.stringify(a.edit), selection: JSON.stringify(a.selection), paint: a.paint.toDataURL("image/png"), erase: a.erase.toDataURL("image/png") };
  }
  async function restoreCanvas(target, source) {
    const image = new Image(); image.src = source; await image.decode(); const context = target.getContext("2d"); context.clearRect(0, 0, target.width, target.height); context.drawImage(image, 0, 0);
  }
  async function restoreSnapshot(saved) {
    const a = activeAsset(); a.edit = JSON.parse(saved.edit); a.selection = JSON.parse(saved.selection);
    await Promise.all([restoreCanvas(a.paint, saved.paint), restoreCanvas(a.erase, saved.erase)]);
  }
  function pushHistory(before) {
    if (!activeAsset() || !before) return;
    state.history.push(before); if (state.history.length > 30) state.history.shift();
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
      const url = URL.createObjectURL(file);
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        if (!image.naturalWidth || !image.naturalHeight) throw new Error("Image has no dimensions");
        const paint = document.createElement("canvas"), erase = document.createElement("canvas");
        paint.width = erase.width = image.naturalWidth; paint.height = erase.height = image.naturalHeight;
        state.assets.push({ file, image, paint, erase, selection: null, url, edit: defaultEdit(image) });
      } catch {
        URL.revokeObjectURL(url);
        showToast("Could not open " + file.name);
      }
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
    t.drawImage(a.image, c.x, c.y, c.width, c.height, -dw / 2, -dh / 2, dw, dh);
    t.drawImage(a.paint, c.x, c.y, c.width, c.height, -dw / 2, -dh / 2, dw, dh);
    t.globalCompositeOperation = "destination-out"; t.drawImage(a.erase, c.x, c.y, c.width, c.height, -dw / 2, -dh / 2, dw, dh); t.restore();
    if (e.warmth) { t.save(); t.globalCompositeOperation = "source-atop"; t.globalAlpha = Math.abs(e.warmth) / 500; t.fillStyle = e.warmth > 0 ? "#ff9a45" : "#5588ff"; t.fillRect(0, 0, width, height); t.restore(); }
  }
  function render() {
    const a = activeAsset(); if (!a) return; const c = a.edit.crop, stage = $("canvasStage"), rotated = Math.abs(a.edit.rotation % 180) === 90;
    const sourceW = rotated ? c.height : c.width, sourceH = rotated ? c.width : c.height;
    const fit = Math.min((stage.clientWidth - 70) / sourceW, (stage.clientHeight - 70) / sourceH, 1);
    const scale = state.zoom || Math.max(.02, fit), width = Math.max(1, Math.round(sourceW * scale)), height = Math.max(1, Math.round(sourceH * scale));
    renderTo(canvas, width, height); interactionCanvas.width = width; interactionCanvas.height = height;
    $("canvasWrap").style.width = width + "px"; $("canvasWrap").style.height = height + "px"; drawSelection();
    $("zoomOutput").value = state.zoom ? Math.round(scale * 100) + "%" : "Fit";
    $("sourceInfo").textContent = a.file.name + " · " + a.image.width + " × " + a.image.height + " · " + formatBytes(a.file.size);
    $("editedInfo").textContent = Math.round(c.width) + " × " + Math.round(c.height);
  }
  function sourceToCanvas(point) {
    const a = activeAsset(), e = a.edit, c = e.crop, rotated = Math.abs(e.rotation % 180) === 90;
    const dw = rotated ? canvas.height : canvas.width, dh = rotated ? canvas.width : canvas.height;
    let x = (point.x - c.x) / c.width * dw - dw / 2, y = (point.y - c.y) / c.height * dh - dh / 2;
    const rad = e.rotation * Math.PI / 180, rx = x * Math.cos(rad) - y * Math.sin(rad), ry = x * Math.sin(rad) + y * Math.cos(rad);
    return { x: canvas.width / 2 + rx * (e.flipX ? -1 : 1), y: canvas.height / 2 + ry * (e.flipY ? -1 : 1) };
  }
  function canvasToSource(x, y) {
    const a = activeAsset(), e = a.edit, c = e.crop, rotated = Math.abs(e.rotation % 180) === 90;
    const dw = rotated ? canvas.height : canvas.width, dh = rotated ? canvas.width : canvas.height;
    let qx = (x - canvas.width / 2) * (e.flipX ? -1 : 1), qy = (y - canvas.height / 2) * (e.flipY ? -1 : 1);
    const rad = -e.rotation * Math.PI / 180, rx = qx * Math.cos(rad) - qy * Math.sin(rad), ry = qx * Math.sin(rad) + qy * Math.cos(rad);
    return { x: c.x + (rx / dw + .5) * c.width, y: c.y + (ry / dh + .5) * c.height };
  }
  function drawSelection(transient) {
    const overlay = interactionCanvas.getContext("2d"); overlay.clearRect(0, 0, interactionCanvas.width, interactionCanvas.height);
    const selection = transient || activeAsset()?.selection; if (!selection) return;
    const points = selection.points.map(sourceToCanvas); if (points.length < 2) return;
    overlay.save(); overlay.beginPath();
    if (selection.type === "rect") overlay.rect(points[0].x, points[0].y, points[1].x - points[0].x, points[1].y - points[0].y);
    else { overlay.moveTo(points[0].x, points[0].y); points.slice(1).forEach(p => overlay.lineTo(p.x, p.y)); if (!transient) overlay.closePath(); }
    overlay.setLineDash([5, 4]); overlay.lineWidth = 1.5; overlay.strokeStyle = "#ffffff"; overlay.stroke(); overlay.setLineDash([5, 4]); overlay.lineDashOffset = 5; overlay.strokeStyle = "#171819"; overlay.stroke(); overlay.restore();
  }
  function mutate(change) { const before = snapshot(); change(activeAsset().edit); pushHistory(before); syncControls(); render(); }
  async function undo() { if (!state.history.length) return; state.future.push(snapshot()); await restoreSnapshot(state.history.pop()); syncControls(); render(); updateHistoryButtons(); }
  async function redo() { if (!state.future.length) return; state.history.push(snapshot()); await restoreSnapshot(state.future.pop()); syncControls(); render(); updateHistoryButtons(); }
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
  function clipToSelection(context) {
    const selection = activeAsset().selection; if (!selection || selection.points.length < 2) return;
    context.beginPath();
    if (selection.type === "rect") {
      const [a, b] = selection.points; context.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    } else {
      context.moveTo(selection.points[0].x, selection.points[0].y);
      selection.points.slice(1).forEach(p => context.lineTo(p.x, p.y)); context.closePath();
    }
    context.clip();
  }
  function paintPoint(from, to) {
    const a = activeAsset(), context = a.paint.getContext("2d"), size = Math.max(1, +$("toolSize").value);
    context.save(); clipToSelection(context); context.lineCap = "round"; context.lineJoin = "round"; context.lineWidth = state.tool === "pencil" ? 1 : size;
    context.globalCompositeOperation = state.tool === "eraser" ? "destination-out" : "source-over";
    context.strokeStyle = $("toolColor").value; context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke(); context.restore();
  }
  function hexRgba(hex) { return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255]; }
  function floodFill(point) {
    const a = activeAsset(), width = a.paint.width, height = a.paint.height, x = Math.floor(point.x), y = Math.floor(point.y);
    if (x < 0 || y < 0 || x >= width || y >= height || width * height > 40000000) return showToast("That image is too large for flood fill");
    const sample = document.createElement("canvas"); sample.width = width; sample.height = height; const sctx = sample.getContext("2d");
    sctx.drawImage(a.image, 0, 0); sctx.drawImage(a.paint, 0, 0); const data = sctx.getImageData(0, 0, width, height), pixels = data.data, start = (y * width + x) * 4;
    const target = [pixels[start], pixels[start + 1], pixels[start + 2], pixels[start + 3]], fill = hexRgba($("toolColor").value), tolerance = +$("fillTolerance").value * 2.55;
    if (target.every((v, i) => Math.abs(v - fill[i]) <= tolerance)) return;
    const overlay = a.paint.getContext("2d").getImageData(0, 0, width, height), out = overlay.data, seen = new Uint8Array(width * height), stack = [y * width + x];
    let selectionPath = null;
    if (a.selection) {
      selectionPath = new Path2D(); const pts = a.selection.points;
      if (a.selection.type === "rect") selectionPath.rect(pts[0].x, pts[0].y, pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      else { selectionPath.moveTo(pts[0].x, pts[0].y); pts.slice(1).forEach(p => selectionPath.lineTo(p.x, p.y)); selectionPath.closePath(); }
    }
    const matches = index => { const p = index * 4; return Math.abs(pixels[p] - target[0]) <= tolerance && Math.abs(pixels[p + 1] - target[1]) <= tolerance && Math.abs(pixels[p + 2] - target[2]) <= tolerance && Math.abs(pixels[p + 3] - target[3]) <= tolerance; };
    while (stack.length) {
      const index = stack.pop(); if (index < 0 || index >= width * height || seen[index] || !matches(index)) continue; seen[index] = 1;
      const px = index % width, py = (index / width) | 0;
      if (selectionPath && !sctx.isPointInPath(selectionPath, px, py)) continue;
      const p = index * 4; out[p] = fill[0]; out[p + 1] = fill[1]; out[p + 2] = fill[2]; out[p + 3] = 255;
      if (px > 0) stack.push(index - 1); if (px + 1 < width) stack.push(index + 1); if (py > 0) stack.push(index - width); if (py + 1 < height) stack.push(index + width);
    }
    a.paint.getContext("2d").putImageData(overlay, 0, 0);
  }
  function selectTool(tool) {
    state.tool = tool; document.querySelectorAll(".paint-tool").forEach(button => button.classList.toggle("active", button.dataset.tool === tool));
    const names = { select: "Rectangle select", lasso: "Lasso select", eyedropper: "Eyedropper", fill: "Flood fill", pencil: "Pencil", brush: "Brush", eraser: "Eraser" };
    $("activeToolName").textContent = names[tool]; interactionCanvas.style.cursor = tool === "eyedropper" ? "crosshair" : tool === "fill" ? "cell" : "crosshair";
  }
  function pointerPosition(event) { const rect = interactionCanvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) * interactionCanvas.width / rect.width, y: (event.clientY - rect.top) * interactionCanvas.height / rect.height }; }
  function pointerDown(event) {
    if (!activeAsset()) return; event.preventDefault(); interactionCanvas.setPointerCapture(event.pointerId);
    const local = pointerPosition(event), point = canvasToSource(local.x, local.y), before = snapshot();
    if (state.tool === "eyedropper") {
      const pixel = canvas.getContext("2d").getImageData(Math.max(0, Math.min(canvas.width - 1, local.x)), Math.max(0, Math.min(canvas.height - 1, local.y)), 1, 1).data;
      $("toolColor").value = "#" + [pixel[0], pixel[1], pixel[2]].map(v => v.toString(16).padStart(2, "0")).join(""); showToast("Colour sampled"); return;
    }
    if (state.tool === "fill") { floodFill(point); pushHistory(before); render(); return; }
    state.gesture = { before, start: point, last: point, points: [point] };
    if (["pencil", "brush", "eraser"].includes(state.tool)) paintPoint(point, point);
  }
  function pointerMove(event) {
    if (!state.gesture) return; const local = pointerPosition(event), point = canvasToSource(local.x, local.y);
    if (["pencil", "brush", "eraser"].includes(state.tool)) { paintPoint(state.gesture.last, point); state.gesture.last = point; render(); }
    else if (state.tool === "select") drawSelection({ type: "rect", points: [state.gesture.start, point] });
    else { state.gesture.points.push(point); drawSelection({ type: "lasso", points: state.gesture.points }); }
  }
  function pointerUp(event) {
    if (!state.gesture) return; const local = pointerPosition(event), point = canvasToSource(local.x, local.y), gesture = state.gesture; state.gesture = null;
    if (state.tool === "select") activeAsset().selection = { type: "rect", points: [gesture.start, point] };
    else if (state.tool === "lasso") { gesture.points.push(point); if (gesture.points.length > 2) activeAsset().selection = { type: "lasso", points: gesture.points }; }
    pushHistory(gesture.before); render();
  }
  function selectionBounds(selection) {
    const xs = selection.points.map(p => p.x), ys = selection.points.map(p => p.y);
    return { x: Math.max(0, Math.min(...xs)), y: Math.max(0, Math.min(...ys)), width: Math.max(1, Math.min(activeAsset().image.width, Math.max(...xs)) - Math.max(0, Math.min(...xs))), height: Math.max(1, Math.min(activeAsset().image.height, Math.max(...ys)) - Math.max(0, Math.min(...ys))) };
  }

  ["emptyOpenButton", "addButton"].forEach(id => $(id).addEventListener("click", () => $("fileInput").click()));
  $("fileInput").addEventListener("change", e => { loadFiles(e.target.files); e.target.value = ""; });
  document.addEventListener("paste", e => loadFiles([...e.clipboardData.items].filter(i => i.kind === "file").map(i => i.getAsFile())));
  ["dragenter", "dragover"].forEach(type => document.addEventListener(type, e => { e.preventDefault(); if (!$("editor").hidden) $("canvasStage").classList.add("dragging"); }));
  ["dragleave", "drop"].forEach(type => document.addEventListener(type, e => { e.preventDefault(); $("canvasStage").classList.remove("dragging"); }));
  document.addEventListener("drop", e => loadFiles(e.dataTransfer.files));
  document.querySelectorAll(".paint-tool").forEach(button => button.addEventListener("click", () => selectTool(button.dataset.tool)));
  interactionCanvas.addEventListener("pointerdown", pointerDown); interactionCanvas.addEventListener("pointermove", pointerMove); interactionCanvas.addEventListener("pointerup", pointerUp); interactionCanvas.addEventListener("pointercancel", pointerUp);
  $("fillTolerance").addEventListener("input", () => $("toleranceValue").value = $("fillTolerance").value);
  $("clearSelection").addEventListener("click", () => { if (!activeAsset()?.selection) return; const before = snapshot(); activeAsset().selection = null; pushHistory(before); render(); });
  $("cropToSelection").addEventListener("click", () => { const a = activeAsset(); if (!a?.selection) return showToast("Make a selection first"); const before = snapshot(); a.edit.crop = selectionBounds(a.selection); a.selection = null; pushHistory(before); syncControls(); render(); });
  $("deleteSelection").addEventListener("click", () => {
    const a = activeAsset(); if (!a?.selection) return showToast("Make a selection first"); const before = snapshot(), context = a.erase.getContext("2d");
    context.save(); clipToSelection(context); context.fillStyle = "#000"; context.fillRect(0, 0, a.erase.width, a.erase.height); context.restore(); a.selection = null; pushHistory(before); render();
  });
  document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => { document.querySelectorAll(".tab").forEach(t => { const active = t === tab; t.classList.toggle("active", active); t.setAttribute("aria-selected", active); }); $("editPanel").hidden = tab.dataset.tab !== "edit"; $("exportPanel").hidden = tab.dataset.tab !== "export"; }));
  $("undoButton").addEventListener("click", undo); $("redoButton").addEventListener("click", redo);
  $("resetButton").addEventListener("click", () => { const before = snapshot(), a = activeAsset(); a.edit = defaultEdit(a.image); a.selection = null; a.paint.getContext("2d").clearRect(0, 0, a.paint.width, a.paint.height); a.erase.getContext("2d").clearRect(0, 0, a.erase.width, a.erase.height); pushHistory(before); syncControls(); render(); });
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
