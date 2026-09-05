(() => {
	"use strict";
	const $ = id => document.getElementById(id);
	const canvas = $("previewCanvas");
	const interactionCanvas = $("interactionCanvas");
	const adjustmentIds = ["brightness", "contrast", "saturation", "warmth", "blur"];
	const extension = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"};
	const colours = ["#f3a6b8", "#ffbf91", "#f7dc8a", "#bfe3a1", "#92d8d0", "#9ec9f2", "#b9afe8", "#d3a6dc", "#fff1df", "#d9d5cc", "#a6adb0", "#71787b", "#424749", "#252829", "#17191a", "#090a0a"];
	const state = {assets: [], active: -1, zoom: 0, history: [], future: [], tool: "select", gesture: null, clipboard: null, colour: colours[0], restoring: false};
	let toastTimer;

	const makeCanvas = (width, height) => { const result = document.createElement("canvas"); result.width = width; result.height = height; return result; };
	const activeAsset = () => state.assets[state.active];
	const activeLayer = () => { const asset = activeAsset(); return asset?.layers[asset.activeLayer]; };
	const defaultEdit = image => ({rotation: 0, flipX: false, flipY: false, crop: {x: 0, y: 0, width: image.naturalWidth || image.width, height: image.naturalHeight || image.height}, brightness: 0, contrast: 0, saturation: 0, warmth: 0, blur: 0});
	const cleanName = name => name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "image";
	const formatBytes = bytes => bytes < 1024 ? bytes + " B" : bytes < 1048576 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / 1048576).toFixed(1) + " MB";
	const showToast = message => { $("toast").textContent = message; $("toast").classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2200); };

	function snapshot() {
		const asset = activeAsset();
		if (!asset || state.restoring) return null;
		return {
			edit: JSON.stringify(asset.edit),
			selection: JSON.stringify(asset.selection),
			activeLayer: asset.activeLayer,
			layers: asset.layers.map(layer => ({name: layer.name, visible: layer.visible, opacity: layer.opacity, data: layer.canvas.toDataURL("image/png")}))
		};
	}
	async function canvasFromURL(url, width, height) {
		const result = makeCanvas(width, height), image = new Image(); image.src = url; await image.decode(); result.getContext("2d").drawImage(image, 0, 0); return result;
	}
	async function restoreSnapshot(saved) {
		const asset = activeAsset(); state.restoring = true;
		asset.edit = JSON.parse(saved.edit); asset.selection = JSON.parse(saved.selection); asset.activeLayer = saved.activeLayer;
		asset.layers = await Promise.all(saved.layers.map(async layer => ({...layer, canvas: await canvasFromURL(layer.data, asset.width, asset.height)})));
		state.restoring = false;
	}
	function pushHistory(before) {
		if (!before) return;
		state.history.push(before); if (state.history.length > 25) state.history.shift(); state.future = []; updateHistoryButtons();
	}
	function updateHistoryButtons() { $("undoButton").disabled = !state.history.length || state.restoring; $("redoButton").disabled = !state.future.length || state.restoring; }
	async function undo() {
		if (!state.history.length || state.restoring) return;
		const current = snapshot(), saved = state.history.pop(); state.future.push(current); await restoreSnapshot(saved); syncControls(); render(); updateHistoryButtons();
	}
	async function redo() {
		if (!state.future.length || state.restoring) return;
		const current = snapshot(), saved = state.future.pop(); state.history.push(current); await restoreSnapshot(saved); syncControls(); render(); updateHistoryButtons();
	}

	async function decodeFile(file) {
		const url = URL.createObjectURL(file), image = new Image(); image.src = url;
		try { await image.decode(); if (!image.naturalWidth) throw new Error(); return {url, image}; }
		catch (error) { URL.revokeObjectURL(url); throw error; }
	}
	async function loadFiles(files) {
		const images = [...files].filter(file => file?.type?.startsWith("image/"));
		if (!images.length) return showToast("Choose a supported image file");
		for (const file of images) {
			try {
				const {url, image} = await decodeFile(file), base = makeCanvas(image.naturalWidth, image.naturalHeight);
				base.getContext("2d").drawImage(image, 0, 0);
				state.assets.push({file, image, url, width: image.naturalWidth, height: image.naturalHeight, edit: defaultEdit(image), selection: null, activeLayer: 0, layers: [{name: "Background", canvas: base, visible: true, opacity: 1}]});
			} catch { showToast("Could not open " + file.name); }
		}
		if (state.active < 0 && state.assets.length) { $("emptyState").hidden = true; $("editor").hidden = false; selectAsset(0); }
		else renderAssets();
	}
	function renderAssets() {
		$("assetList").replaceChildren(...state.assets.map((asset, index) => {
			const button = document.createElement("button"); button.className = "asset-item" + (index === state.active ? " active" : ""); button.type = "button";
			const image = document.createElement("img"); image.className = "asset-thumb"; image.src = asset.url; image.alt = "";
			const meta = document.createElement("span"); meta.className = "asset-meta";
			const name = document.createElement("span"); name.className = "asset-name"; name.textContent = asset.file.name;
			const size = document.createElement("span"); size.className = "asset-size"; size.textContent = asset.width + " × " + asset.height;
			meta.append(name, size); button.append(image, meta); button.addEventListener("click", () => selectAsset(index)); return button;
		}));
	}
	function selectAsset(index) {
		state.active = index; state.history = []; state.future = []; state.zoom = 0; state.gesture = null; renderAssets(); syncControls(); updateHistoryButtons(); render();
	}
	function syncControls() {
		const asset = activeAsset(); if (!asset) return; const edit = asset.edit;
		["cropX", "cropY", "cropWidth", "cropHeight"].forEach((id, i) => $(id).value = Math.round([edit.crop.x, edit.crop.y, edit.crop.width, edit.crop.height][i]));
		adjustmentIds.forEach(id => { $(id).value = edit[id]; $(id + "Value").value = edit[id]; });
		$("exportName").value = cleanName(asset.file.name); $("exportWidth").value = Math.round(edit.crop.width); $("exportHeight").value = Math.round(edit.crop.height);
		renderLayers(); updateMarkup();
	}

	const filterString = edit => `brightness(${100 + edit.brightness}%) contrast(${100 + edit.contrast}%) saturate(${100 + edit.saturation}%) blur(${edit.blur}px)`;
	function drawLayers(target, width, height) {
		const asset = activeAsset(), edit = asset.edit, crop = edit.crop, context = target.getContext("2d");
		target.width = width; target.height = height; context.clearRect(0, 0, width, height); context.save(); context.filter = filterString(edit);
		context.translate(width / 2, height / 2); context.scale(edit.flipX ? -1 : 1, edit.flipY ? -1 : 1); context.rotate(edit.rotation * Math.PI / 180);
		const quarter = Math.abs(edit.rotation % 180) === 90, drawWidth = quarter ? height : width, drawHeight = quarter ? width : height;
		for (const layer of asset.layers) if (layer.visible) { context.globalAlpha = layer.opacity; context.drawImage(layer.canvas, crop.x, crop.y, crop.width, crop.height, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight); }
		context.restore();
		if (edit.warmth) { context.save(); context.globalCompositeOperation = "source-atop"; context.globalAlpha = Math.abs(edit.warmth) / 500; context.fillStyle = edit.warmth > 0 ? "#ff9a45" : "#5588ff"; context.fillRect(0, 0, width, height); context.restore(); }
	}
	function render() {
		const asset = activeAsset(); if (!asset) return; const crop = asset.edit.crop, stage = $("canvasStage"), rotated = Math.abs(asset.edit.rotation % 180) === 90;
		const sourceWidth = rotated ? crop.height : crop.width, sourceHeight = rotated ? crop.width : crop.height;
		const fit = Math.min((stage.clientWidth - 70) / sourceWidth, (stage.clientHeight - 70) / sourceHeight, 1), scale = state.zoom || Math.max(.02, fit);
		const width = Math.max(1, Math.round(sourceWidth * scale)), height = Math.max(1, Math.round(sourceHeight * scale));
		drawLayers(canvas, width, height); interactionCanvas.width = width; interactionCanvas.height = height; $("canvasWrap").style.width = width + "px"; $("canvasWrap").style.height = height + "px"; drawSelection();
		$("zoomOutput").value = state.zoom ? Math.round(scale * 100) + "%" : "Fit";
		$("sourceInfo").textContent = asset.file.name + " · " + asset.width + " × " + asset.height + " · " + formatBytes(asset.file.size);
		$("editedInfo").textContent = Math.round(crop.width) + " × " + Math.round(crop.height) + " · " + asset.layers.length + (asset.layers.length === 1 ? " layer" : " layers");
	}
	function mutate(change) { const before = snapshot(); change(activeAsset()); pushHistory(before); syncControls(); render(); }

	function sourceToCanvas(point) {
		const edit = activeAsset().edit, crop = edit.crop, quarter = Math.abs(edit.rotation % 180) === 90;
		const drawWidth = quarter ? canvas.height : canvas.width, drawHeight = quarter ? canvas.width : canvas.height;
		const x = (point.x - crop.x) / crop.width * drawWidth - drawWidth / 2, y = (point.y - crop.y) / crop.height * drawHeight - drawHeight / 2, angle = edit.rotation * Math.PI / 180;
		const rx = x * Math.cos(angle) - y * Math.sin(angle), ry = x * Math.sin(angle) + y * Math.cos(angle);
		return {x: canvas.width / 2 + rx * (edit.flipX ? -1 : 1), y: canvas.height / 2 + ry * (edit.flipY ? -1 : 1)};
	}
	function canvasToSource(x, y) {
		const edit = activeAsset().edit, crop = edit.crop, quarter = Math.abs(edit.rotation % 180) === 90;
		const drawWidth = quarter ? canvas.height : canvas.width, drawHeight = quarter ? canvas.width : canvas.height;
		const qx = (x - canvas.width / 2) * (edit.flipX ? -1 : 1), qy = (y - canvas.height / 2) * (edit.flipY ? -1 : 1), angle = -edit.rotation * Math.PI / 180;
		const rx = qx * Math.cos(angle) - qy * Math.sin(angle), ry = qx * Math.sin(angle) + qy * Math.cos(angle);
		return {x: crop.x + (rx / drawWidth + .5) * crop.width, y: crop.y + (ry / drawHeight + .5) * crop.height};
	}
	function drawSelection(transient) {
		const context = interactionCanvas.getContext("2d"); context.clearRect(0, 0, interactionCanvas.width, interactionCanvas.height);
		const selection = transient || activeAsset()?.selection; if (!selection || selection.points.length < 2) return;
		const points = selection.points.map(sourceToCanvas); context.save(); context.beginPath();
		if (selection.type === "rect") context.rect(points[0].x, points[0].y, points[1].x - points[0].x, points[1].y - points[0].y);
		else { context.moveTo(points[0].x, points[0].y); points.slice(1).forEach(point => context.lineTo(point.x, point.y)); if (!transient) context.closePath(); }
		context.setLineDash([5, 4]); context.lineWidth = 1.5; context.strokeStyle = "#fff"; context.stroke(); context.lineDashOffset = 5; context.strokeStyle = "#171819"; context.stroke(); context.restore();
	}
	function selectionPath(context, selection = activeAsset().selection) {
		if (!selection || selection.points.length < 2) return false; const points = selection.points; context.beginPath();
		if (selection.type === "rect") context.rect(points[0].x, points[0].y, points[1].x - points[0].x, points[1].y - points[0].y);
		else { context.moveTo(points[0].x, points[0].y); points.slice(1).forEach(point => context.lineTo(point.x, point.y)); context.closePath(); }
		return true;
	}
	function clipSelection(context) { if (selectionPath(context)) context.clip(); }
	function selectionBounds(selection = activeAsset().selection) {
		const xs = selection.points.map(point => point.x), ys = selection.points.map(point => point.y), x = Math.max(0, Math.min(...xs)), y = Math.max(0, Math.min(...ys));
		return {x, y, width: Math.max(1, Math.min(activeAsset().width, Math.max(...xs)) - x), height: Math.max(1, Math.min(activeAsset().height, Math.max(...ys)) - y)};
	}

	function parseColour(value) {
		const test = makeCanvas(1, 1).getContext("2d"); test.fillStyle = "#010203"; test.fillStyle = value.trim();
		if (test.fillStyle === "#010203" && value.trim().toLowerCase() !== "#010203" && value.trim().toLowerCase() !== "rgb(1, 2, 3)") return null;
		test.fillRect(0, 0, 1, 1); const pixel = test.getImageData(0, 0, 1, 1).data; return {css: value.trim(), hex: "#" + [...pixel.slice(0, 3)].map(v => v.toString(16).padStart(2, "0")).join("")};
	}
	function setColour(value, keepText = false) {
		const parsed = parseColour(value); if (!parsed) { $("colorText").setAttribute("aria-invalid", "true"); return false; }
		state.colour = parsed.css; $("colourSwatch").style.background = parsed.css; $("colorText").removeAttribute("aria-invalid"); if (!keepText) $("colorText").value = value; return true;
	}
	function renderPalette() {
		$("paletteBar").replaceChildren(...colours.map(colour => { const button = document.createElement("button"); button.type = "button"; button.className = "palette-colour"; button.style.background = colour; button.title = colour; button.setAttribute("aria-label", "Use colour " + colour); button.addEventListener("click", () => setColour(colour)); return button; }));
	}

	function compositeSource() {
		const asset = activeAsset(), result = makeCanvas(asset.width, asset.height), context = result.getContext("2d");
		for (const layer of asset.layers) if (layer.visible) { context.globalAlpha = layer.opacity; context.drawImage(layer.canvas, 0, 0); } context.globalAlpha = 1; return result;
	}
	function paintLine(from, to) {
		const context = activeLayer().canvas.getContext("2d"), size = Math.max(1, +$("toolSize").value); context.save(); clipSelection(context); context.lineCap = "round"; context.lineJoin = "round";
		context.lineWidth = state.tool === "pencil" ? 1 : size; context.globalCompositeOperation = state.tool === "eraser" ? "destination-out" : "source-over"; context.strokeStyle = state.colour;
		context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke(); context.restore();
	}
	function drawShape(context, tool, start, end) {
		context.beginPath(); if (tool === "line") { context.moveTo(start.x, start.y); context.lineTo(end.x, end.y); }
		else if (tool === "rectangle") context.rect(start.x, start.y, end.x - start.x, end.y - start.y);
		else { const cx = (start.x + end.x) / 2, cy = (start.y + end.y) / 2; context.ellipse(cx, cy, Math.abs(end.x - start.x) / 2, Math.abs(end.y - start.y) / 2, 0, 0, Math.PI * 2); }
	}
	function commitShape(tool, start, end) {
		const context = activeLayer().canvas.getContext("2d"); context.save(); clipSelection(context); context.lineWidth = Math.max(1, +$("toolSize").value); context.strokeStyle = state.colour; context.fillStyle = state.colour; drawShape(context, tool, start, end); $("shapeFill").checked && tool !== "line" ? context.fill() : context.stroke(); context.restore();
	}
	function drawShapePreview(tool, start, end) {
		drawSelection(); const context = interactionCanvas.getContext("2d"), a = sourceToCanvas(start), b = sourceToCanvas(end); context.save(); context.lineWidth = 2; context.strokeStyle = state.colour; context.fillStyle = state.colour; drawShape(context, tool, a, b); if ($("shapeFill").checked && tool !== "line") { context.globalAlpha = .35; context.fill(); } else context.stroke(); context.restore();
	}
	function floodFill(point) {
		const asset = activeAsset(), width = asset.width, height = asset.height, x = Math.floor(point.x), y = Math.floor(point.y);
		if (x < 0 || y < 0 || x >= width || y >= height || width * height > 40000000) return showToast("That image is too large for flood fill");
		const sample = compositeSource(), sampleContext = sample.getContext("2d"), pixels = sampleContext.getImageData(0, 0, width, height).data, targetIndex = (y * width + x) * 4;
		const target = [pixels[targetIndex], pixels[targetIndex + 1], pixels[targetIndex + 2], pixels[targetIndex + 3]], parsed = parseColour(state.colour), colourContext = makeCanvas(1, 1).getContext("2d");
		colourContext.fillStyle = parsed.css; colourContext.fillRect(0, 0, 1, 1); const fill = colourContext.getImageData(0, 0, 1, 1).data, tolerance = +$("fillTolerance").value * 2.55;
		const layerContext = activeLayer().canvas.getContext("2d"), image = layerContext.getImageData(0, 0, width, height), out = image.data, seen = new Uint8Array(width * height), stack = [y * width + x], selection = asset.selection;
		const matches = index => { const i = index * 4; return Math.abs(pixels[i] - target[0]) <= tolerance && Math.abs(pixels[i + 1] - target[1]) <= tolerance && Math.abs(pixels[i + 2] - target[2]) <= tolerance && Math.abs(pixels[i + 3] - target[3]) <= tolerance; };
		while (stack.length) {
			const index = stack.pop(); if (index < 0 || index >= width * height || seen[index] || !matches(index)) continue; seen[index] = 1; const px = index % width, py = (index / width) | 0;
			if (selection) { selectionPath(sampleContext, selection); if (!sampleContext.isPointInPath(px, py)) continue; }
			const i = index * 4; out[i] = fill[0]; out[i + 1] = fill[1]; out[i + 2] = fill[2]; out[i + 3] = fill[3];
			if (px) stack.push(index - 1); if (px + 1 < width) stack.push(index + 1); if (py) stack.push(index - width); if (py + 1 < height) stack.push(index + width);
		}
		layerContext.putImageData(image, 0, 0);
	}
	function insertText(point) {
		const text = $("textValue").value; if (!text) return showToast("Enter some text first"); const before = snapshot(), context = activeLayer().canvas.getContext("2d");
		context.save(); clipSelection(context); context.fillStyle = state.colour; context.font = `${Math.max(6, +$("textSize").value)}px system-ui, sans-serif`; context.textBaseline = "top"; context.fillText(text, point.x, point.y); context.restore(); pushHistory(before); render();
	}

	function selectTool(tool) {
		if (state.tool !== tool && activeAsset()?.selection) { activeAsset().selection = null; drawSelection(); }
		state.tool = tool; document.querySelectorAll(".paint-tool").forEach(button => button.classList.toggle("active", button.dataset.tool === tool));
		const names = {select: "Rectangle select", lasso: "Lasso select", eyedropper: "Eyedropper", fill: "Flood fill", pencil: "Pencil", brush: "Brush", eraser: "Eraser", line: "Line", rectangle: "Rectangle", ellipse: "Ellipse", text: "Text"};
		$("activeToolName").textContent = names[tool]; interactionCanvas.style.cursor = tool === "fill" ? "cell" : tool === "text" ? "text" : "crosshair";
	}
	function pointerPosition(event) { const rect = interactionCanvas.getBoundingClientRect(); return {x: (event.clientX - rect.left) * interactionCanvas.width / rect.width, y: (event.clientY - rect.top) * interactionCanvas.height / rect.height}; }
	function pointerDown(event) {
		if (!activeAsset() || event.button !== 0) return; event.preventDefault(); interactionCanvas.setPointerCapture(event.pointerId);
		const local = pointerPosition(event), point = canvasToSource(local.x, local.y), before = snapshot();
		if (state.tool === "eyedropper") { const pixel = canvas.getContext("2d").getImageData(Math.max(0, Math.min(canvas.width - 1, local.x)), Math.max(0, Math.min(canvas.height - 1, local.y)), 1, 1).data; setColour("#" + [...pixel.slice(0, 3)].map(v => v.toString(16).padStart(2, "0")).join("")); return showToast("Colour sampled"); }
		if (state.tool === "fill") { floodFill(point); pushHistory(before); return render(); }
		if (state.tool === "text") return insertText(point);
		state.gesture = {before, start: point, last: point, points: [point]};
		if (["pencil", "brush", "eraser"].includes(state.tool)) paintLine(point, point);
	}
	function pointerMove(event) {
		if (!state.gesture) return; const local = pointerPosition(event), point = canvasToSource(local.x, local.y), gesture = state.gesture;
		if (["pencil", "brush", "eraser"].includes(state.tool)) { paintLine(gesture.last, point); gesture.last = point; render(); }
		else if (state.tool === "select") drawSelection({type: "rect", points: [gesture.start, point]});
		else if (state.tool === "lasso") { gesture.points.push(point); drawSelection({type: "lasso", points: gesture.points}); }
		else drawShapePreview(state.tool, gesture.start, point);
	}
	function pointerUp(event) {
		if (!state.gesture) return; const point = canvasToSource(pointerPosition(event).x, pointerPosition(event).y), gesture = state.gesture; state.gesture = null;
		if (state.tool === "select") activeAsset().selection = {type: "rect", points: [gesture.start, point]};
		else if (state.tool === "lasso") { gesture.points.push(point); if (gesture.points.length > 2) activeAsset().selection = {type: "lasso", points: gesture.points}; }
		else if (["line", "rectangle", "ellipse"].includes(state.tool)) commitShape(state.tool, gesture.start, point);
		pushHistory(gesture.before); render();
	}

	function clearPixels() {
		const asset = activeAsset(); if (!asset?.selection) return showToast("Make a selection first"); const before = snapshot(), context = activeLayer().canvas.getContext("2d");
		context.save(); context.globalCompositeOperation = "destination-out"; selectionPath(context); context.fill(); context.restore(); asset.selection = null; pushHistory(before); render();
	}
	async function copySelection(cut = false) {
		const asset = activeAsset(); if (!asset?.selection) return showToast("Make a selection first"); const bounds = selectionBounds(), source = compositeSource(), clip = makeCanvas(Math.ceil(bounds.width), Math.ceil(bounds.height)), context = clip.getContext("2d");
		context.save(); context.translate(-bounds.x, -bounds.y); selectionPath(context); context.clip(); context.drawImage(source, 0, 0); context.restore(); state.clipboard = {canvas: clip, x: bounds.x, y: bounds.y};
		try { const blob = await new Promise(resolve => clip.toBlob(resolve, "image/png")); if (blob && navigator.clipboard?.write && window.ClipboardItem) await navigator.clipboard.write([new ClipboardItem({"image/png": blob})]); } catch {}
		if (cut) clearPixels(); else showToast("Selection copied");
	}
	function pasteCanvas(source, x, y, name = "Pasted selection") {
		const asset = activeAsset(), before = snapshot(), layerCanvas = makeCanvas(asset.width, asset.height); layerCanvas.getContext("2d").drawImage(source, Math.round(x), Math.round(y));
		asset.layers.push({name, canvas: layerCanvas, visible: true, opacity: 1}); asset.activeLayer = asset.layers.length - 1; asset.selection = {type: "rect", points: [{x, y}, {x: x + source.width, y: y + source.height}]}; pushHistory(before); syncControls(); render(); showToast("Pasted as new layer");
	}
	async function pasteSelection() {
		if (state.clipboard) return pasteCanvas(state.clipboard.canvas, state.clipboard.x + 10, state.clipboard.y + 10);
		try {
			for (const item of await navigator.clipboard.read()) { const type = item.types.find(value => value.startsWith("image/")); if (!type) continue; const blob = await item.getType(type), image = new Image(); image.src = URL.createObjectURL(blob); await image.decode(); return pasteCanvas(image, activeAsset().edit.crop.x, activeAsset().edit.crop.y); }
		} catch {}
		showToast("Nothing to paste");
	}

	function renderLayers() {
		const asset = activeAsset(); if (!asset) return; $("layersList").replaceChildren(...asset.layers.map((layer, index) => {
			const row = document.createElement("div"); row.className = "layer-row" + (index === asset.activeLayer ? " active" : "");
			const visible = document.createElement("button"); visible.type = "button"; visible.className = "layer-visible"; visible.textContent = layer.visible ? "●" : "○"; visible.title = layer.visible ? "Hide layer" : "Show layer";
			visible.addEventListener("click", event => { event.stopPropagation(); mutate(current => current.layers[index].visible = !current.layers[index].visible); });
			const name = document.createElement("span"); name.textContent = layer.name;
			name.addEventListener("dblclick", event => { event.stopPropagation(); const before = snapshot(); name.contentEditable = "true"; name.focus(); document.getSelection()?.selectAllChildren(name); const finish = () => { name.contentEditable = "false"; layer.name = name.textContent.trim() || "Layer"; pushHistory(before); renderLayers(); }; name.addEventListener("blur", finish, {once: true}); name.addEventListener("keydown", keyEvent => { if (keyEvent.key === "Enter") { keyEvent.preventDefault(); name.blur(); } }); });
			const opacity = document.createElement("span"); opacity.className = "layer-row-opacity"; opacity.textContent = Math.round(layer.opacity * 100) + "%";
			row.append(visible, name, opacity); row.addEventListener("click", () => { asset.activeLayer = index; renderLayers(); }); return row;
		}).reverse());
		const layer = activeLayer(); if (layer) { $("layerOpacity").value = Math.round(layer.opacity * 100); $("layerOpacityValue").value = Math.round(layer.opacity * 100); }
	}
	function addLayer(name = "Layer " + (activeAsset().layers.length + 1)) { mutate(asset => { asset.layers.push({name, canvas: makeCanvas(asset.width, asset.height), visible: true, opacity: 1}); asset.activeLayer = asset.layers.length - 1; }); }
	function duplicateLayer() { const layer = activeLayer(); if (!layer) return; mutate(asset => { const copy = makeCanvas(asset.width, asset.height); copy.getContext("2d").drawImage(layer.canvas, 0, 0); asset.layers.splice(asset.activeLayer + 1, 0, {...layer, name: layer.name + " copy", canvas: copy}); asset.activeLayer++; }); }
	function moveLayer(delta) { const asset = activeAsset(), next = asset.activeLayer + delta; if (next < 0 || next >= asset.layers.length) return; mutate(current => { [current.layers[current.activeLayer], current.layers[next]] = [current.layers[next], current.layers[current.activeLayer]]; current.activeLayer = next; }); }

	function validCrop() {
		const asset = activeAsset(), values = ["cropX", "cropY", "cropWidth", "cropHeight"].map(id => Number($(id).value)); if (values.some(value => !Number.isFinite(value)) || values[2] < 1 || values[3] < 1) return null;
		const x = Math.max(0, Math.min(values[0], asset.width - 1)), y = Math.max(0, Math.min(values[1], asset.height - 1)); return {x, y, width: Math.max(1, Math.min(values[2], asset.width - x)), height: Math.max(1, Math.min(values[3], asset.height - y))};
	}
	function updateMarkup() {
		if (!activeAsset()) return; const name = cleanName($("exportName").value), ext = extension[$("exportFormat").value] || "webp", widths = [...document.querySelectorAll("[name=variant]:checked")].map(input => +input.value).filter(width => width <= activeAsset().edit.crop.width);
		$("markupOutput").value = widths.length ? `<img src="${name}-${widths[0]}w.${ext}"\n  srcset="${widths.map(width => `${name}-${width}w.${ext} ${width}w`).join(", ")}"\n  sizes="100vw" alt="">` : "Select at least one output width.";
	}
	const outputDimensions = width => { const crop = activeAsset().edit.crop; return [Math.round(width), Math.max(1, Math.round(width * crop.height / crop.width))]; };
	const canvasBlob = (output, type, quality) => new Promise(resolve => output.toBlob(resolve, type, quality));
	function download(blob, name) { const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
	async function makeExport(width, height) { const output = makeCanvas(width, height); drawLayers(output, width, height); return canvasBlob(output, $("exportFormat").value, +$("quality").value / 100); }
	async function exportImage() {
		const width = Math.max(1, +$("exportWidth").value), height = Math.max(1, +$("exportHeight").value); $("exportButton").disabled = true;
		try { const blob = await makeExport(width, height); if (!blob) throw new Error(); $("estimatedSize").textContent = formatBytes(blob.size); download(blob, cleanName($("exportName").value) + "." + extension[$("exportFormat").value]); showToast("Image exported"); } catch { showToast("This browser could not encode that format"); } finally { $("exportButton").disabled = false; }
	}
	async function exportVariants() {
		const widths = [...document.querySelectorAll("[name=variant]:checked")].map(input => +input.value).filter(width => width <= activeAsset().edit.crop.width); if (!widths.length) return showToast("Select a width no larger than the crop");
		$("variantsButton").disabled = true; let count = 0; for (const width of widths) { const [w, h] = outputDimensions(width), blob = await makeExport(w, h); if (blob) { download(blob, `${cleanName($("exportName").value)}-${w}w.${extension[$("exportFormat").value]}`); count++; await new Promise(resolve => setTimeout(resolve, 120)); } }
		$("variantsButton").disabled = false; updateMarkup(); showToast(count + (count === 1 ? " variant downloaded" : " variants downloaded"));
	}

	function showTab(tab) {
		document.querySelectorAll(".tab").forEach(button => { const active = button.dataset.tab === tab; button.classList.toggle("active", active); button.setAttribute("aria-selected", active); });
		["edit", "layers", "export"].forEach(name => $(name + "Panel").hidden = name !== tab);
	}
	["emptyOpenButton", "addButton"].forEach(id => $(id).addEventListener("click", () => $("fileInput").click()));
	$("fileInput").addEventListener("change", event => { loadFiles(event.target.files); event.target.value = ""; });
	document.addEventListener("paste", event => { const files = [...event.clipboardData.items].filter(item => item.kind === "file").map(item => item.getAsFile()); if (!files.length) return; event.preventDefault(); if (!activeAsset()) loadFiles(files); else decodeFile(files[0]).then(({image, url}) => { pasteCanvas(image, activeAsset().edit.crop.x, activeAsset().edit.crop.y, "Pasted image"); URL.revokeObjectURL(url); }); });
	["dragenter", "dragover"].forEach(type => document.addEventListener(type, event => { event.preventDefault(); if (!$("editor").hidden) $("canvasStage").classList.add("dragging"); }));
	["dragleave", "drop"].forEach(type => document.addEventListener(type, event => { event.preventDefault(); $("canvasStage").classList.remove("dragging"); }));
	document.addEventListener("drop", event => loadFiles(event.dataTransfer.files));
	document.querySelectorAll(".left-tab").forEach(button => button.addEventListener("click", () => { document.querySelectorAll(".left-tab").forEach(tab => { const active = tab === button; tab.classList.toggle("active", active); tab.setAttribute("aria-selected", active); }); $("toolsPanel").hidden = button.dataset.leftTab !== "tools"; $("imagesPanel").hidden = button.dataset.leftTab !== "images"; }));
	document.querySelectorAll(".paint-tool").forEach(button => button.addEventListener("click", () => selectTool(button.dataset.tool)));
	document.querySelectorAll(".tab").forEach(button => button.addEventListener("click", () => showTab(button.dataset.tab)));
	interactionCanvas.addEventListener("pointerdown", pointerDown); interactionCanvas.addEventListener("pointermove", pointerMove); interactionCanvas.addEventListener("pointerup", pointerUp); interactionCanvas.addEventListener("pointercancel", pointerUp);
	interactionCanvas.addEventListener("contextmenu", event => { event.preventDefault(); $("contextMenu").style.left = event.clientX + "px"; $("contextMenu").style.top = event.clientY + "px"; $("contextMenu").classList.add("show"); });
	document.addEventListener("pointerdown", event => { if (!event.target.closest("#contextMenu")) $("contextMenu").classList.remove("show"); });
	document.querySelectorAll("#contextMenu [data-command]").forEach(button => button.addEventListener("click", () => { const command = button.dataset.command; $("contextMenu").classList.remove("show"); if (command === "copy") copySelection(); if (command === "cut") copySelection(true); if (command === "paste") pasteSelection(); if (command === "delete") clearPixels(); if (command === "clear" && activeAsset()) { activeAsset().selection = null; render(); } }));
	$("undoButton").addEventListener("click", undo); $("redoButton").addEventListener("click", redo); $("copyButton").addEventListener("click", () => copySelection()); $("cutButton").addEventListener("click", () => copySelection(true)); $("pasteButton").addEventListener("click", pasteSelection);
	$("clearSelection").addEventListener("click", () => { if (activeAsset()) { activeAsset().selection = null; render(); } }); $("deleteSelection").addEventListener("click", clearPixels);
	$("cropToSelection").addEventListener("click", () => { if (!activeAsset()?.selection) return showToast("Make a selection first"); mutate(asset => { asset.edit.crop = selectionBounds(); asset.selection = null; }); });
	$("resetButton").addEventListener("click", () => mutate(asset => { const base = makeCanvas(asset.width, asset.height); base.getContext("2d").drawImage(asset.image, 0, 0); asset.edit = defaultEdit(asset.image); asset.selection = null; asset.layers = [{name: "Background", canvas: base, visible: true, opacity: 1}]; asset.activeLayer = 0; }));
	$("rotateLeft").addEventListener("click", () => mutate(asset => asset.edit.rotation = (asset.edit.rotation + 270) % 360)); $("rotateRight").addEventListener("click", () => mutate(asset => asset.edit.rotation = (asset.edit.rotation + 90) % 360));
	$("flipHorizontal").addEventListener("click", () => mutate(asset => asset.edit.flipX = !asset.edit.flipX)); $("flipVertical").addEventListener("click", () => mutate(asset => asset.edit.flipY = !asset.edit.flipY));
	$("resetCrop").addEventListener("click", () => mutate(asset => asset.edit.crop = {x: 0, y: 0, width: asset.width, height: asset.height}));
	["cropX", "cropY", "cropWidth", "cropHeight"].forEach(id => $(id).addEventListener("change", () => { const crop = validCrop(); if (crop) mutate(asset => asset.edit.crop = crop); }));
	$("applyAspect").addEventListener("click", () => { const ratio = +$("aspectRatio").value; if (!ratio) return; mutate(asset => { let width = asset.width, height = width / ratio; if (height > asset.height) { height = asset.height; width = height * ratio; } asset.edit.crop = {x: (asset.width - width) / 2, y: (asset.height - height) / 2, width, height}; }); });
	adjustmentIds.forEach(id => { let before; const remember = () => { if (!before) before = snapshot(); }; $(id).addEventListener("pointerdown", () => before = snapshot()); $(id).addEventListener("keydown", remember); $(id).addEventListener("input", () => { remember(); activeAsset().edit[id] = +$(id).value; $(id + "Value").value = $(id).value; render(); }); $(id).addEventListener("change", () => { pushHistory(before); before = null; syncControls(); }); });
	$("resetAdjustments").addEventListener("click", () => mutate(asset => adjustmentIds.forEach(id => asset.edit[id] = 0)));
	$("fillTolerance").addEventListener("input", () => $("toleranceValue").value = $("fillTolerance").value);
	$("colourSwatch").addEventListener("click", () => { $("colorText").focus(); $("colorText").select(); }); $("colorText").addEventListener("change", () => { if (!setColour($("colorText").value, true)) showToast("Enter a valid CSS colour"); });
	$("addLayer").addEventListener("click", () => addLayer()); $("duplicateLayer").addEventListener("click", duplicateLayer); $("deleteLayer").addEventListener("click", () => { if (activeAsset().layers.length === 1) return showToast("An image needs at least one layer"); mutate(asset => { asset.layers.splice(asset.activeLayer, 1); asset.activeLayer = Math.max(0, asset.activeLayer - 1); }); });
	$("layerUp").addEventListener("click", () => moveLayer(1)); $("layerDown").addEventListener("click", () => moveLayer(-1)); let layerBefore;
	$("layerOpacity").addEventListener("pointerdown", () => layerBefore = snapshot()); $("layerOpacity").addEventListener("input", () => { activeLayer().opacity = +$("layerOpacity").value / 100; $("layerOpacityValue").value = $("layerOpacity").value; renderLayers(); render(); }); $("layerOpacity").addEventListener("change", () => { pushHistory(layerBefore); layerBefore = null; });
	$("zoomIn").addEventListener("click", () => { state.zoom = Math.min(4, (state.zoom || canvas.width / activeAsset().edit.crop.width) * 1.25); render(); }); $("zoomOut").addEventListener("click", () => { state.zoom = Math.max(.05, (state.zoom || canvas.width / activeAsset().edit.crop.width) / 1.25); render(); });
	$("exportWidth").addEventListener("change", () => { if ($("lockRatio").checked) $("exportHeight").value = outputDimensions(+$("exportWidth").value)[1]; }); $("exportHeight").addEventListener("change", () => { if ($("lockRatio").checked) $("exportWidth").value = Math.round(+$("exportHeight").value * activeAsset().edit.crop.width / activeAsset().edit.crop.height); });
	$("exportFormat").addEventListener("change", () => { $("qualityLabel").hidden = $("exportFormat").value === "image/png"; updateMarkup(); }); $("quality").addEventListener("input", () => $("qualityValue").value = $("quality").value);
	$("exportName").addEventListener("input", updateMarkup); document.querySelectorAll("[name=variant]").forEach(input => input.addEventListener("change", updateMarkup)); $("exportButton").addEventListener("click", exportImage); $("variantsButton").addEventListener("click", exportVariants);
	$("copyMarkup").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("markupOutput").value); showToast("Markup copied"); } catch { $("markupOutput").select(); document.execCommand("copy"); showToast("Markup copied"); } });
	document.addEventListener("keydown", event => {
		if (!activeAsset() || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return; const key = event.key.toLowerCase(), modifier = event.ctrlKey || event.metaKey;
		if (modifier && key === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); } else if (modifier && key === "y") { event.preventDefault(); redo(); } else if (modifier && key === "c") { event.preventDefault(); copySelection(); } else if (modifier && key === "x") { event.preventDefault(); copySelection(true); } else if (modifier && key === "v") { event.preventDefault(); pasteSelection(); } else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); clearPixels(); } else if (event.key === "Escape") { activeAsset().selection = null; render(); }
	});
	window.addEventListener("resize", () => { if (activeAsset() && !state.zoom) render(); });
	renderPalette(); setColour(colours[0]);
})();
