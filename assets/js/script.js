(() => {
	"use strict";
	const $ = id => document.getElementById(id);
	const canvas = $("previewCanvas");
	const interactionCanvas = $("interactionCanvas");
	const adjustmentIds = ["brightness", "contrast", "saturation", "warmth", "blur"];
	const extension = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"};
	const colours = ["#f3a6b8", "#ffb38a", "#f6d77d", "#b9e18f", "#80d7bd", "#83cbea", "#aaa7ed", "#d6a0df", "#a92f53", "#b94d22", "#a17a08", "#39752d", "#087363", "#176386", "#50439a", "#792f85"];
	const state = {assets: [], active: -1, zoom: 0, history: [], future: [], tool: "select", gesture: null, clipboard: null, colour: colours[0], restoring: false, textPoint: null, hue: 345, nudge: null, cloneSource: null, grid: false, draftTimer: null};
	let toastTimer;

	const makeCanvas = (width, height) => { const result = document.createElement("canvas"); result.width = width; result.height = height; return result; };
	const activeAsset = () => state.assets[state.active];
	const activeLayer = () => { const asset = activeAsset(); return asset?.layers[asset.activeLayer]; };
	const canAllocateLayer = (asset = activeAsset()) => { const allowed = asset && asset.width * asset.height * (asset.layers.length + 1) <= 96000000; if (!allowed) showToast("Flatten or resize this large document before adding another layer"); return allowed; };
	const defaultEdit = image => ({rotation: 0, flipX: false, flipY: false, crop: {x: 0, y: 0, width: image.naturalWidth || image.width, height: image.naturalHeight || image.height}, brightness: 0, contrast: 0, saturation: 0, warmth: 0, blur: 0});
	const cleanName = name => name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "image";
	const formatBytes = bytes => bytes < 1024 ? bytes + " B" : bytes < 1048576 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / 1048576).toFixed(1) + " MB";
	const showToast = message => { $("toast").textContent = message; $("toast").classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2200); };

	function snapshot() {
		const asset = activeAsset();
		if (!asset || state.restoring) return null;
		if (asset.width * asset.height * asset.layers.length > 60000000) return null;
		return {
			width: asset.width,
			height: asset.height,
			edit: JSON.stringify(asset.edit),
			selection: JSON.stringify(asset.selection),
			activeLayer: asset.activeLayer,
			layers: asset.layers.map(layer => ({name: layer.name, visible: layer.visible, opacity: layer.opacity, blend: layer.blend || "source-over", floating: Boolean(layer.floating), targetLayer: layer.targetLayer, offsetX: layer.offsetX || 0, offsetY: layer.offsetY || 0, data: layer.canvas.toDataURL("image/png")}))
		};
	}
	async function canvasFromURL(url, width, height) {
		const result = makeCanvas(width, height), image = new Image(); image.src = url; await image.decode(); result.getContext("2d").drawImage(image, 0, 0); return result;
	}
	async function restoreSnapshot(saved) {
		const asset = activeAsset(); state.restoring = true;
		asset.width = saved.width || asset.width; asset.height = saved.height || asset.height; asset.edit = JSON.parse(saved.edit); asset.selection = JSON.parse(saved.selection); asset.activeLayer = saved.activeLayer;
		asset.layers = await Promise.all(saved.layers.map(async layer => ({...layer, canvas: await canvasFromURL(layer.data, asset.width, asset.height)})));
		state.restoring = false;
	}
	function renderHistory() { $("historyList").replaceChildren(...state.history.map((entry, index) => { const item = document.createElement("li"), button = document.createElement("button"); button.type = "button"; button.textContent = `${index + 1}. ${entry.label || "Edit"}`; button.title = "Return to before this edit"; button.addEventListener("click", async () => { while (state.history.length > index) await undo(); }); item.append(button); return item; })); }
	function pushHistory(before, label = "Edit") {
		if (!before) { scheduleDraftSave(); return; }
		before.label = label; state.history.push(before); const asset = activeAsset(), pixels = asset ? asset.width * asset.height * asset.layers.length : 0, limit = pixels > 40000000 ? 3 : pixels > 16000000 ? 8 : 25; while (state.history.length > limit) state.history.shift(); state.future = []; updateHistoryButtons(); renderHistory(); scheduleDraftSave();
	}
	function updateHistoryButtons() { $("undoButton").disabled = !state.history.length || state.restoring; $("redoButton").disabled = !state.future.length || state.restoring; renderHistory(); }
	function updateActionAvailability() {
		const selected = Boolean(activeAsset()?.selection), pasteable = Boolean(state.clipboard);
		document.querySelectorAll('[data-command="copy"],[data-command="cut"]').forEach(button => button.hidden = !selected);
		document.querySelectorAll('[data-command="paste"]').forEach(button => button.hidden = !pasteable);
		document.querySelectorAll('[data-command="delete"],[data-command="clear"]').forEach(button => button.hidden = !selected);
		document.querySelectorAll('[data-action="copy"],[data-action="cut"]').forEach(button => button.hidden = !selected);
		document.querySelectorAll('[data-action="paste"]').forEach(button => button.hidden = !pasteable);
	}
	async function undo() {
		if (!state.history.length || state.restoring) return;
		const current = snapshot(), saved = state.history.pop(); if (current) state.future.push(current); await restoreSnapshot(saved); syncControls(); render(); updateHistoryButtons(); scheduleDraftSave();
	}
	async function redo() {
		if (!state.future.length || state.restoring) return;
		const current = snapshot(), saved = state.future.pop(); if (current) state.history.push(current); await restoreSnapshot(saved); syncControls(); render(); updateHistoryButtons(); scheduleDraftSave();
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
				const {url, image} = await decodeFile(file); if (image.naturalWidth * image.naturalHeight > 40000000) { URL.revokeObjectURL(url); showToast(file.name + " is larger than Pict's 40 MP safety limit"); continue; } const base = makeCanvas(image.naturalWidth, image.naturalHeight);
				base.getContext("2d").drawImage(image, 0, 0);
				state.assets.push({file, image, url, width: image.naturalWidth, height: image.naturalHeight, edit: defaultEdit(image), selection: null, activeLayer: 0, layers: [{name: "Background", canvas: base, visible: true, opacity: 1, blend: "source-over"}]});
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
		state.active = index; state.history = []; state.future = []; state.zoom = 0; state.gesture = null; state.cloneSource = null; renderAssets(); syncControls(); updateHistoryButtons(); updateActionAvailability(); render();
	}
	function syncControls() {
		const asset = activeAsset(); if (!asset) return; const edit = asset.edit;
		["cropX", "cropY", "cropWidth", "cropHeight"].forEach((id, i) => $(id).value = Math.round([edit.crop.x, edit.crop.y, edit.crop.width, edit.crop.height][i]));
		adjustmentIds.forEach(id => { $(id).value = edit[id]; $(id + "Value").value = edit[id]; });
		$("exportName").value = cleanName(asset.file.name); $("exportWidth").value = Math.round(edit.crop.width); $("exportHeight").value = Math.round(edit.crop.height);
		renderLayers(); $("layerBlend").value = activeLayer()?.blend || "source-over"; updateMarkup();
	}

	const filterString = (edit, scale = 1) => `brightness(${100 + edit.brightness}%) contrast(${100 + edit.contrast}%) saturate(${100 + edit.saturation}%) blur(${edit.blur * scale}px)`;
	function drawLayers(target, width, height) {
		const asset = activeAsset(), edit = asset.edit, crop = edit.crop, context = target.getContext("2d");
		target.width = width; target.height = height; context.clearRect(0, 0, width, height); context.save(); context.filter = filterString(edit, width / (Math.abs(edit.rotation % 180) === 90 ? crop.height : crop.width));
		context.translate(width / 2, height / 2); context.scale(edit.flipX ? -1 : 1, edit.flipY ? -1 : 1); context.rotate(edit.rotation * Math.PI / 180);
		const quarter = Math.abs(edit.rotation % 180) === 90, drawWidth = quarter ? height : width, drawHeight = quarter ? width : height;
		for (const layer of asset.layers) if (layer.visible) { context.globalAlpha = layer.opacity; context.globalCompositeOperation = layer.blend || "source-over"; context.drawImage(layer.canvas, crop.x - (layer.offsetX || 0), crop.y - (layer.offsetY || 0), crop.width, crop.height, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight); }
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
		updateActionAvailability();
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
		if (state.grid && activeAsset()) { const crop = activeAsset().edit.crop, stepX = interactionCanvas.width / crop.width, stepY = interactionCanvas.height / crop.height; if (Math.min(stepX, stepY) >= 6) { context.save(); context.beginPath(); for (let x = 0; x <= interactionCanvas.width; x += stepX) { context.moveTo(x, 0); context.lineTo(x, interactionCanvas.height); } for (let y = 0; y <= interactionCanvas.height; y += stepY) { context.moveTo(0, y); context.lineTo(interactionCanvas.width, y); } context.strokeStyle = "#ffffff1f"; context.lineWidth = 1; context.stroke(); context.restore(); } }
		const selection = transient || activeAsset()?.selection; if (!selection) return;
		if (selection.type === "magic") { const bounds = selectionBounds(selection), a = sourceToCanvas({x: bounds.x, y: bounds.y}), b = sourceToCanvas({x: bounds.x + bounds.width, y: bounds.y + bounds.height}); context.save(); context.fillStyle = "#d5b87122"; selection.spans.forEach(span => { const p = sourceToCanvas({x: span.x, y: span.y}), q = sourceToCanvas({x: span.x + span.width, y: span.y + 1}); context.fillRect(p.x, p.y, q.x - p.x, q.y - p.y); }); context.setLineDash([5, 4]); context.strokeStyle = "#fff"; context.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); context.restore(); drawTransformHandles(context, selection); return; }
		if (selection.points.length < 2) return;
		const points = selection.points.map(sourceToCanvas); context.save(); context.beginPath();
		if (selection.type === "rect") context.rect(points[0].x, points[0].y, points[1].x - points[0].x, points[1].y - points[0].y);
		else { context.moveTo(points[0].x, points[0].y); points.slice(1).forEach(point => context.lineTo(point.x, point.y)); if (!transient) context.closePath(); }
		context.setLineDash([5, 4]); context.lineWidth = 1.5; context.strokeStyle = "#fff"; context.stroke(); context.lineDashOffset = 5; context.strokeStyle = "#171819"; context.stroke(); context.restore(); if (!transient) drawTransformHandles(context, selection);
	}
	function selectionPath(context, selection = activeAsset().selection) {
		if (!selection) return false; context.beginPath();
		if (selection.type === "magic") { selection.spans.forEach(span => context.rect(span.x, span.y, span.width, 1)); return true; }
		if (selection.points.length < 2) return false; const points = selection.points;
		if (selection.type === "rect") context.rect(points[0].x, points[0].y, points[1].x - points[0].x, points[1].y - points[0].y);
		else { context.moveTo(points[0].x, points[0].y); points.slice(1).forEach(point => context.lineTo(point.x, point.y)); context.closePath(); }
		return true;
	}
	function clipSelection(context) { if (selectionPath(context)) context.clip(); }
	function selectionBounds(selection = activeAsset().selection) {
		if (selection.type === "magic") { let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0; selection.spans.forEach(span => { minX = Math.min(minX, span.x); minY = Math.min(minY, span.y); maxX = Math.max(maxX, span.x + span.width); maxY = Math.max(maxY, span.y + 1); }); return {x: minX, y: minY, width: maxX - minX, height: maxY - minY}; }
		const xs = selection.points.map(point => point.x), ys = selection.points.map(point => point.y), x = Math.max(0, Math.min(...xs)), y = Math.max(0, Math.min(...ys));
		return {x, y, width: Math.max(1, Math.min(activeAsset().width, Math.max(...xs)) - x), height: Math.max(1, Math.min(activeAsset().height, Math.max(...ys)) - y)};
	}
	function transformHandles(selection = activeAsset()?.selection) {
		if (!selection || state.tool !== "move" || !activeLayer()?.floating) return [];
		const bounds = selectionBounds(selection), left = bounds.x, top = bounds.y, right = left + bounds.width, bottom = top + bounds.height, centreX = (left + right) / 2, centreY = (top + bottom) / 2;
		const entries = [["nw",left,top],["n",centreX,top],["ne",right,top],["e",right,centreY],["se",right,bottom],["s",centreX,bottom],["sw",left,bottom],["w",left,centreY]].map(([name,x,y]) => ({name, source:{x,y}, canvas:sourceToCanvas({x,y})}));
		const topCanvas = sourceToCanvas({x:centreX,y:top}), centreCanvas = sourceToCanvas({x:centreX,y:centreY}), dx = topCanvas.x-centreCanvas.x, dy = topCanvas.y-centreCanvas.y, length = Math.hypot(dx,dy) || 1;
		entries.push({name:"rotate", source:{x:centreX,y:top}, canvas:{x:topCanvas.x + dx / length * 26, y:topCanvas.y + dy / length * 26}}); return entries;
	}
	function drawTransformHandles(context, selection) {
		const handles = transformHandles(selection); if (!handles.length) return; const top = handles.find(handle => handle.name === "n"), rotate = handles.find(handle => handle.name === "rotate");
		context.save(); context.setLineDash([]); context.strokeStyle = "#d5b871"; context.lineWidth = 1.25; context.beginPath(); context.moveTo(top.canvas.x, top.canvas.y); context.lineTo(rotate.canvas.x, rotate.canvas.y); context.stroke();
		for (const handle of handles) { context.beginPath(); context.fillStyle = handle.name === "rotate" ? "#d5b871" : "#f0f1ed"; context.strokeStyle = "#171819"; if (handle.name === "rotate") context.arc(handle.canvas.x, handle.canvas.y, 5, 0, Math.PI*2); else context.rect(handle.canvas.x-4,handle.canvas.y-4,8,8); context.fill(); context.stroke(); } context.restore();
	}
	function hitTransformHandle(local) { return transformHandles().find(handle => Math.hypot(local.x-handle.canvas.x, local.y-handle.canvas.y) <= 10) || null; }
	function beginTransform(handle, point, before) {
		const asset = activeAsset(), layer = activeLayer(), bounds = selectionBounds(), global = makeCanvas(asset.width, asset.height), crop = makeCanvas(Math.ceil(bounds.width), Math.ceil(bounds.height)); global.getContext("2d").drawImage(layer.canvas, layer.offsetX||0, layer.offsetY||0); crop.getContext("2d").drawImage(global, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, crop.width, crop.height);
		return {before,start:point,last:point,transform:handle.name,bounds:{...bounds},crop,centre:{x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2},startAngle:Math.atan2(point.y-(bounds.y+bounds.height/2),point.x-(bounds.x+bounds.width/2))};
	}
	function updateSelectionTransform(gesture, point, keepRatio) {
		const asset=activeAsset(), layer=activeLayer(), context=layer.canvas.getContext("2d"), original=gesture.bounds; context.clearRect(0,0,asset.width,asset.height); layer.offsetX=0; layer.offsetY=0;
		if (gesture.transform === "rotate") { const angle=Math.atan2(point.y-gesture.centre.y,point.x-gesture.centre.x)-gesture.startAngle, c=Math.abs(Math.cos(angle)), s=Math.abs(Math.sin(angle)), width=original.width*c+original.height*s, height=original.width*s+original.height*c; context.save(); context.translate(gesture.centre.x,gesture.centre.y); context.rotate(angle); context.drawImage(gesture.crop,-original.width/2,-original.height/2,original.width,original.height); context.restore(); asset.selection={type:"rect",points:[{x:gesture.centre.x-width/2,y:gesture.centre.y-height/2},{x:gesture.centre.x+width/2,y:gesture.centre.y+height/2}]}; return;
		}
		let left=original.x,top=original.y,right=original.x+original.width,bottom=original.y+original.height; const h=gesture.transform; if(h.includes("w"))left=point.x;if(h.includes("e"))right=point.x;if(h.includes("n"))top=point.y;if(h.includes("s"))bottom=point.y;
		if(keepRatio && h.length===2){const ratio=original.width/original.height, width=Math.abs(right-left), height=Math.abs(bottom-top); if(width/height>ratio){const adjusted=width/ratio; if(h.includes("n"))top=bottom-adjusted;else bottom=top+adjusted;}else{const adjusted=height*ratio;if(h.includes("w"))left=right-adjusted;else right=left+adjusted;}}
		if(Math.abs(right-left)<2||Math.abs(bottom-top)<2)return; const x=Math.min(left,right),y=Math.min(top,bottom),width=Math.abs(right-left),height=Math.abs(bottom-top); context.drawImage(gesture.crop,0,0,gesture.crop.width,gesture.crop.height,x,y,width,height); asset.selection={type:"rect",points:[{x,y},{x:x+width,y:y+height}]};
	}
	function selectionMask(selection = activeAsset().selection, feather = +$("selectionFeather").value) {
		const asset = activeAsset(), base = makeCanvas(asset.width, asset.height), context = base.getContext("2d"); context.fillStyle = "#fff"; if (selectionPath(context, selection)) context.fill(); if (!feather) return base;
		const softened = makeCanvas(asset.width, asset.height), soft = softened.getContext("2d"); soft.filter = `blur(${Math.min(50, feather)}px)`; soft.drawImage(base, 0, 0); return softened;
	}
	function maskToSelection(mask) {
		const {width, height} = mask, alpha = mask.getContext("2d").getImageData(0, 0, width, height).data, spans = []; for (let y = 0; y < height; y++) for (let x = 0; x < width;) { while (x < width && alpha[(y * width + x) * 4 + 3] < 128) x++; const from = x; while (x < width && alpha[(y * width + x) * 4 + 3] >= 128) x++; if (x > from) spans.push({x: from, y, width: x - from}); } return spans.length ? {type: "magic", spans} : null;
	}
	function combineSelection(next) {
		const asset = activeAsset(), current = asset.selection, mode = $("selectionMode").value; if (!current || mode === "replace") { asset.selection = next; return; }
		const currentMask = selectionMask(current, 0), nextMask = selectionMask(next, 0), context = currentMask.getContext("2d"); if (mode === "add") context.globalCompositeOperation = "source-over"; if (mode === "subtract") context.globalCompositeOperation = "destination-out"; if (mode === "intersect") context.globalCompositeOperation = "destination-in"; context.drawImage(nextMask, 0, 0); asset.selection = maskToSelection(currentMask);
	}
	function invertSelection() { const asset = activeAsset(); if (!asset) return; const before = snapshot(), mask = selectionMask(asset.selection, 0), context = mask.getContext("2d"); context.globalCompositeOperation = "xor"; context.fillStyle = "#fff"; context.fillRect(0, 0, asset.width, asset.height); asset.selection = maskToSelection(mask); pushHistory(before, "Invert selection"); render(); }

	function parseColour(value) {
		const test = makeCanvas(1, 1).getContext("2d"); test.fillStyle = "#010203"; test.fillStyle = value.trim();
		if (test.fillStyle === "#010203" && value.trim().toLowerCase() !== "#010203" && value.trim().toLowerCase() !== "rgb(1, 2, 3)") return null;
		test.fillRect(0, 0, 1, 1); const pixel = test.getImageData(0, 0, 1, 1).data; return {css: value.trim(), hex: "#" + [...pixel.slice(0, 3)].map(v => v.toString(16).padStart(2, "0")).join("")};
	}
	function hexToRgb(hex) { const value = hex.replace("#", "").slice(0, 6); return {r: parseInt(value.slice(0, 2), 16), g: parseInt(value.slice(2, 4), 16), b: parseInt(value.slice(4, 6), 16)}; }
	function rgbToHex({r, g, b}) { return "#" + [r, g, b].map(value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")).join(""); }
	function rgbToHsv({r, g, b}) { r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b), difference = max - min; let h = 0; if (difference) h = max === r ? 60 * (((g - b) / difference) % 6) : max === g ? 60 * ((b - r) / difference + 2) : 60 * ((r - g) / difference + 4); return {h: Math.round((h + 360) % 360), s: Math.round(max ? difference / max * 100 : 0), v: Math.round(max * 100)}; }
	function hsvToRgb({h, s, v}) { s /= 100; v /= 100; const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c; let values = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]; return {r: (values[0] + m) * 255, g: (values[1] + m) * 255, b: (values[2] + m) * 255}; }
	function syncColourInputs(rgb) {
		const hex = rgbToHex(rgb), hsv = rgbToHsv(rgb); $("hexInput").value = hex; $("redInput").value = Math.round(rgb.r); $("greenInput").value = Math.round(rgb.g); $("blueInput").value = Math.round(rgb.b); $("hueInput").value = hsv.h; $("saturationInput").value = hsv.s; $("valueInput").value = hsv.v; $("hueRange").value = hsv.h; state.hue = hsv.h; $("colourSwatch").style.background = hex;
	}
	function setColour(value) {
		const parsed = parseColour(value); if (!parsed) return false; state.colour = parsed.hex; syncColourInputs(hexToRgb(parsed.hex)); return true;
	}
	function renderPalette() {
		$("paletteBar").replaceChildren(...colours.map(colour => { const button = document.createElement("button"); button.type = "button"; button.className = "palette-colour"; button.style.background = colour; button.title = colour; button.setAttribute("aria-label", "Use colour " + colour); button.addEventListener("click", () => setColour(colour)); return button; }));
	}
	function drawColourField() {
		const field = $("colourField"), context = field.getContext("2d"); context.clearRect(0, 0, field.width, field.height); context.fillStyle = `hsl(${state.hue} 100% 50%)`; context.fillRect(0, 0, field.width, field.height);
		const white = context.createLinearGradient(0, 0, field.width, 0); white.addColorStop(0, "#fff"); white.addColorStop(1, "#fff0"); context.fillStyle = white; context.fillRect(0, 0, field.width, field.height);
		const black = context.createLinearGradient(0, 0, 0, field.height); black.addColorStop(0, "#0000"); black.addColorStop(1, "#000"); context.fillStyle = black; context.fillRect(0, 0, field.width, field.height);
	}
	function openColourDialog() { syncColourInputs(hexToRgb(parseColour(state.colour).hex)); drawColourField(); $("colourDialog").showModal(); }
	function sampleColourField(event) {
		const field = $("colourField"), rect = field.getBoundingClientRect(), x = Math.max(0, Math.min(field.width - 1, (event.clientX - rect.left) * field.width / rect.width)), y = Math.max(0, Math.min(field.height - 1, (event.clientY - rect.top) * field.height / rect.height));
		const pixel = field.getContext("2d").getImageData(x, y, 1, 1).data; syncColourInputs({r: pixel[0], g: pixel[1], b: pixel[2]});
	}

	function compositeSource() {
		const asset = activeAsset(), result = makeCanvas(asset.width, asset.height), context = result.getContext("2d");
		for (const layer of asset.layers) if (layer.visible) { context.globalAlpha = layer.opacity; context.globalCompositeOperation = layer.blend || "source-over"; context.drawImage(layer.canvas, layer.offsetX || 0, layer.offsetY || 0); } context.globalAlpha = 1; context.globalCompositeOperation = "source-over"; return result;
	}
	function contiguousSpans(point) {
		const asset = activeAsset(), width = asset.width, height = asset.height, x = Math.floor(point.x), y = Math.floor(point.y); if (x < 0 || y < 0 || x >= width || y >= height || width * height > 40000000) return null;
		const pixels = compositeSource().getContext("2d").getImageData(0, 0, width, height).data, start = (y * width + x) * 4, target = pixels.slice(start, start + 4), tolerance = +$("fillTolerance").value * 2.55, seen = new Uint8Array(width * height), selected = new Uint8Array(width * height), stack = [y * width + x];
		const matches = index => { const i = index * 4; return Math.abs(pixels[i] - target[0]) <= tolerance && Math.abs(pixels[i + 1] - target[1]) <= tolerance && Math.abs(pixels[i + 2] - target[2]) <= tolerance && Math.abs(pixels[i + 3] - target[3]) <= tolerance; };
		while (stack.length) { const index = stack.pop(); if (index < 0 || index >= width * height || seen[index] || !matches(index)) continue; seen[index] = 1; selected[index] = 1; const px = index % width, py = (index / width) | 0; if (px) stack.push(index - 1); if (px + 1 < width) stack.push(index + 1); if (py) stack.push(index - width); if (py + 1 < height) stack.push(index + width); }
		const spans = []; for (let py = 0; py < height; py++) for (let px = 0; px < width;) { while (px < width && !selected[py * width + px]) px++; const from = px; while (px < width && selected[py * width + px]) px++; if (px > from) spans.push({x: from, y: py, width: px - from}); } return spans;
	}
	function magicSelect(point) { const spans = contiguousSpans(point); if (!spans?.length) return showToast("No matching area found"); combineSelection({type: "magic", spans}); drawSelection(); updateActionAvailability(); showToast("Similar contiguous pixels selected"); }
	function recolourLine(from, to) { const layer = activeLayer(), context = layer.canvas.getContext("2d"), size = Math.max(1, +$("toolSize").value); context.save(); context.translate(-(layer.offsetX || 0), -(layer.offsetY || 0)); clipSelection(context); context.globalCompositeOperation = "color"; context.globalAlpha = +$("toolOpacity").value / 100; context.strokeStyle = state.colour; context.lineWidth = size; context.lineCap = "round"; context.lineJoin = "round"; context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke(); context.restore(); }
	function cloneLine(from, to, gesture) { const layer = activeLayer(), context = layer.canvas.getContext("2d"), size = Math.max(1, +$("toolSize").value), distance = Math.hypot(to.x - from.x, to.y - from.y), steps = Math.max(1, Math.ceil(distance / Math.max(1, size * +$("brushSpacing").value / 100))); context.save(); context.translate(-(layer.offsetX || 0), -(layer.offsetY || 0)); clipSelection(context); context.globalAlpha = +$("toolOpacity").value / 100; for (let i = 0; i <= steps; i++) { const t = i / steps, x = from.x + (to.x - from.x) * t, y = from.y + (to.y - from.y) * t, sx = x + gesture.cloneOffset.x, sy = y + gesture.cloneOffset.y; context.save(); context.beginPath(); context.arc(x, y, size / 2, 0, Math.PI * 2); context.clip(); context.drawImage(gesture.cloneSource, sx - size / 2, sy - size / 2, size, size, x - size / 2, y - size / 2, size, size); context.restore(); } context.restore(); }
	function paintLine(from, to) {
		const layer = activeLayer(), context = layer.canvas.getContext("2d"), size = Math.max(1, +$("toolSize").value); context.save(); context.translate(-(layer.offsetX || 0), -(layer.offsetY || 0)); clipSelection(context); context.globalCompositeOperation = state.tool === "eraser" ? "destination-out" : "source-over"; context.globalAlpha = +$("toolOpacity").value / 100;
		if (state.tool === "pencil") { context.lineWidth = 1; context.strokeStyle = state.colour; context.beginPath(); context.moveTo(Math.round(from.x) + .5, Math.round(from.y) + .5); context.lineTo(Math.round(to.x) + .5, Math.round(to.y) + .5); context.stroke(); }
		else { const distance = Math.hypot(to.x - from.x, to.y - from.y), spacing = Math.max(1, size * +$("brushSpacing").value / 100), steps = Math.max(1, Math.ceil(distance / spacing)), hardness = +$("brushHardness").value / 100; for (let i = 0; i <= steps; i++) { const t = i / steps, x = from.x + (to.x - from.x) * t, y = from.y + (to.y - from.y) * t; if (hardness >= .99) context.fillStyle = state.tool === "eraser" ? "#000" : state.colour; else { const gradient = context.createRadialGradient(x, y, size * hardness / 2, x, y, size / 2); gradient.addColorStop(0, state.tool === "eraser" ? "#000" : state.colour); gradient.addColorStop(1, state.tool === "eraser" ? "#0000" : state.colour + "00"); context.fillStyle = gradient; } context.beginPath(); context.arc(x, y, size / 2, 0, Math.PI * 2); context.fill(); } } context.restore();
	}
	function drawShape(context, tool, start, end) {
		context.beginPath(); if (tool === "line") { context.moveTo(start.x, start.y); context.lineTo(end.x, end.y); }
		else if (tool === "rectangle") context.rect(start.x, start.y, end.x - start.x, end.y - start.y);
		else { const cx = (start.x + end.x) / 2, cy = (start.y + end.y) / 2; context.ellipse(cx, cy, Math.abs(end.x - start.x) / 2, Math.abs(end.y - start.y) / 2, 0, 0, Math.PI * 2); }
	}
	function commitShape(tool, start, end) {
		const asset = activeAsset(), targetLayer = asset.activeLayer; if (!canAllocateLayer(asset)) { const layer = activeLayer(), context = layer.canvas.getContext("2d"); context.save(); context.translate(-(layer.offsetX || 0), -(layer.offsetY || 0)); clipSelection(context); context.globalAlpha = +$("toolOpacity").value / 100; context.lineWidth = Math.max(1, +$("toolSize").value); context.strokeStyle = state.colour; context.fillStyle = state.colour; drawShape(context, tool, start, end); $("shapeFill").checked && tool !== "line" ? context.fill() : context.stroke(); context.restore(); return; }
		const layerCanvas = makeCanvas(asset.width, asset.height), context = layerCanvas.getContext("2d"); context.globalAlpha = +$("toolOpacity").value / 100; context.lineWidth = Math.max(1, +$("toolSize").value); context.strokeStyle = state.colour; context.fillStyle = state.colour; drawShape(context, tool, start, end); $("shapeFill").checked && tool !== "line" ? context.fill() : context.stroke(); asset.layers.push({name: tool[0].toUpperCase() + tool.slice(1), canvas: layerCanvas, visible: true, opacity: 1, blend: "source-over", floating: true, targetLayer, offsetX: 0, offsetY: 0}); asset.activeLayer = asset.layers.length - 1; asset.selection = {type: "rect", points: [{x: Math.min(start.x, end.x), y: Math.min(start.y, end.y)}, {x: Math.max(start.x, end.x), y: Math.max(start.y, end.y)}]}; selectTool("move", true); syncControls(); showToast("Move the shape, then clear the selection to stamp it");
	}
	function drawShapePreview(tool, start, end) {
		drawSelection(); const context = interactionCanvas.getContext("2d"), a = sourceToCanvas(start), b = sourceToCanvas(end); context.save(); context.lineWidth = 2; context.strokeStyle = state.colour; context.fillStyle = state.colour; drawShape(context, tool, a, b); if ($("shapeFill").checked && tool !== "line") { context.globalAlpha = .35; context.fill(); context.globalAlpha = 1; } else context.stroke();
		if (tool === "rectangle" || tool === "ellipse") { const label = `${Math.round(Math.abs(end.x - start.x))} × ${Math.round(Math.abs(end.y - start.y))}`, x = Math.min(interactionCanvas.width - 88, Math.max(4, b.x + 8)), y = Math.min(interactionCanvas.height - 28, Math.max(4, b.y + 8)); context.font = "12px system-ui"; context.fillStyle = "#171819dd"; context.fillRect(x, y, 80, 22); context.fillStyle = "#f0f1ed"; context.fillText(label, x + 6, y + 15); }
		context.restore();
	}
	function floodFill(point) {
		const asset = activeAsset(), width = asset.width, height = asset.height, x = Math.floor(point.x), y = Math.floor(point.y);
		if (x < 0 || y < 0 || x >= width || y >= height || width * height > 40000000) return showToast("That image is too large for flood fill");
		const sample = compositeSource(), sampleContext = sample.getContext("2d"), pixels = sampleContext.getImageData(0, 0, width, height).data, targetIndex = (y * width + x) * 4;
		const target = [pixels[targetIndex], pixels[targetIndex + 1], pixels[targetIndex + 2], pixels[targetIndex + 3]], parsed = parseColour(state.colour), colourContext = makeCanvas(1, 1).getContext("2d");
		colourContext.fillStyle = parsed.css; colourContext.fillRect(0, 0, 1, 1); const fill = colourContext.getImageData(0, 0, 1, 1).data, tolerance = +$("fillTolerance").value * 2.55;
		const layer = activeLayer(), layerGlobal = makeCanvas(width, height), layerGlobalContext = layerGlobal.getContext("2d"); layerGlobalContext.drawImage(layer.canvas, layer.offsetX || 0, layer.offsetY || 0); const image = layerGlobalContext.getImageData(0, 0, width, height), out = image.data, seen = new Uint8Array(width * height), stack = [y * width + x], selection = asset.selection;
		const matches = index => { const i = index * 4; return Math.abs(pixels[i] - target[0]) <= tolerance && Math.abs(pixels[i + 1] - target[1]) <= tolerance && Math.abs(pixels[i + 2] - target[2]) <= tolerance && Math.abs(pixels[i + 3] - target[3]) <= tolerance; };
		while (stack.length) {
			const index = stack.pop(); if (index < 0 || index >= width * height || seen[index] || !matches(index)) continue; seen[index] = 1; const px = index % width, py = (index / width) | 0;
			if (selection) { selectionPath(sampleContext, selection); if (!sampleContext.isPointInPath(px, py)) continue; }
			const i = index * 4; out[i] = fill[0]; out[i + 1] = fill[1]; out[i + 2] = fill[2]; out[i + 3] = fill[3];
			if (px) stack.push(index - 1); if (px + 1 < width) stack.push(index + 1); if (py) stack.push(index - width); if (py + 1 < height) stack.push(index + width);
		}
		layerGlobalContext.putImageData(image, 0, 0); const layerContext = layer.canvas.getContext("2d"); layerContext.clearRect(0, 0, width, height); layerContext.drawImage(layerGlobal, -(layer.offsetX || 0), -(layer.offsetY || 0));
	}
	function openTextDialog(point) {
		state.textPoint = point; $("textValue").value = ""; $("textDialog").showModal(); setTimeout(() => $("textValue").focus(), 0);
	}
	function applyText() {
		const text = $("textValue").value, point = state.textPoint; if (!text.trim() || !point) return showToast("Enter some text first");
		if (!canAllocateLayer()) return;
		const asset = activeAsset(), before = snapshot(), targetLayer = asset.activeLayer, layerCanvas = makeCanvas(asset.width, asset.height), context = layerCanvas.getContext("2d"), size = Math.max(6, +$("textSize").value), weight = $("textBold").checked ? "700" : "400", style = $("textItalic").checked ? "italic" : "normal", align = $("textAlign").value, lines = text.split("\n");
		context.fillStyle = state.colour; context.globalAlpha = +$("toolOpacity").value / 100; context.font = `${style} ${weight} ${size}px ${$("textFont").value}`; context.textBaseline = "top"; context.textAlign = align;
		lines.forEach((line, index) => context.fillText(line, point.x, point.y + index * size * 1.25));
		const width = Math.max(...lines.map(line => context.measureText(line).width), 1), left = align === "center" ? point.x - width / 2 : align === "right" ? point.x - width : point.x, height = Math.max(size, lines.length * size * 1.25);
		asset.layers.push({name: "Text", canvas: layerCanvas, visible: true, opacity: 1, blend: "source-over", floating: true, targetLayer}); asset.activeLayer = asset.layers.length - 1; asset.selection = {type: "rect", points: [{x: left, y: point.y}, {x: left + width, y: point.y + height}]};
		pushHistory(before); $("textDialog").close(); state.textPoint = null; selectTool("move", true); syncControls(); render(); showToast("Move text, then clear the selection to stamp it");
	}
	function commitFloatingText() {
		const asset = activeAsset(), layer = activeLayer(); if (!layer?.floating) return;
		const targetIndex = Math.max(0, Math.min(layer.targetLayer ?? 0, asset.layers.length - 2)), target = asset.layers[targetIndex]; target.canvas.getContext("2d").drawImage(layer.canvas, (layer.offsetX || 0) - (target.offsetX || 0), (layer.offsetY || 0) - (target.offsetY || 0)); asset.layers.splice(asset.activeLayer, 1); asset.activeLayer = targetIndex; asset.selection = null; renderLayers();
	}
	function clearSelectionAndCommit() { if (!activeAsset()) return; commitFloatingText(); activeAsset().selection = null; render(); }

	function selectTool(tool, preserveSelection = false) {
		const selectionTools = ["select", "lasso", "magic"]; if (state.tool !== tool && activeAsset()?.selection && !preserveSelection && !(selectionTools.includes(state.tool) && selectionTools.includes(tool))) { commitFloatingText(); activeAsset().selection = null; drawSelection(); }
		state.tool = tool; document.querySelectorAll(".paint-tool").forEach(button => button.classList.toggle("active", button.dataset.tool === tool));
		const names = {move: "Move layer", select: "Rectangle select", lasso: "Lasso select", magic: "Magic wand", eyedropper: "Eyedropper", fill: "Flood fill", pencil: "Pencil", brush: "Brush", clone: "Clone stamp", recolour: "Recolour brush", eraser: "Eraser", line: "Line", rectangle: "Rectangle", ellipse: "Ellipse", text: "Text"};
		const hints = {move: "Drag to move. Use the handles to scale or rotate; hold Shift to keep proportions.", select: "Drag to select a rectangular area.", lasso: "Draw a freehand selection.", magic: "Click a contiguous colour area; tolerance controls the match.", eyedropper: "Click the image to sample a colour.", fill: "Click to fill a contiguous colour area.", pencil: "Draw a crisp one-pixel line.", brush: "Draw with the selected size and opacity.", clone: "Alt-click to set a source, then paint elsewhere to clone it.", recolour: "Paint colour while retaining the underlying light and shade.", eraser: "Paint transparency onto the active layer.", line: "Drag between the line endpoints.", rectangle: "Drag a rectangle; enable Fill shapes for a solid shape.", ellipse: "Drag an ellipse; enable Fill shapes for a solid shape.", text: "Click the image, enter text, then move it before stamping."};
		$("activeToolName").textContent = names[tool]; $("activeToolStatus").textContent = names[tool]; $("toolHint").textContent = hints[tool]; interactionCanvas.style.cursor = tool === "move" ? "move" : tool === "fill" ? "cell" : tool === "text" ? "text" : "crosshair"; updateActionAvailability();
	}
	function pointerPosition(event) { const rect = interactionCanvas.getBoundingClientRect(); return {x: (event.clientX - rect.left) * interactionCanvas.width / rect.width, y: (event.clientY - rect.top) * interactionCanvas.height / rect.height}; }
	function shiftActiveLayer(dx, dy) {
		if (!dx && !dy) return; const layer = activeLayer(), oldX = layer.offsetX || 0, oldY = layer.offsetY || 0; layer.offsetX = Math.round(oldX + dx); layer.offsetY = Math.round(oldY + dy); const movedX = layer.offsetX - oldX, movedY = layer.offsetY - oldY, selection = activeAsset().selection;
		if (selection?.type === "magic") selection.spans.forEach(span => { span.x += movedX; span.y += movedY; }); else if (selection) selection.points.forEach(point => { point.x += movedX; point.y += movedY; });
	}
	function pointerDown(event) {
		if (!activeAsset() || event.button !== 0) return; event.preventDefault(); interactionCanvas.setPointerCapture(event.pointerId);
		const local = pointerPosition(event), point = canvasToSource(local.x, local.y), before = snapshot();
		const transformHandle = hitTransformHandle(local); if (transformHandle) { state.gesture = beginTransform(transformHandle, point, before); interactionCanvas.style.cursor = transformHandle.name === "rotate" ? "grabbing" : `${transformHandle.name}-resize`; return; }
		if (state.tool === "eyedropper") { const pixel = canvas.getContext("2d").getImageData(Math.max(0, Math.min(canvas.width - 1, local.x)), Math.max(0, Math.min(canvas.height - 1, local.y)), 1, 1).data; setColour("#" + [...pixel.slice(0, 3)].map(v => v.toString(16).padStart(2, "0")).join("")); return showToast("Colour sampled"); }
		if (state.tool === "fill") { floodFill(point); pushHistory(before); return render(); }
		if (state.tool === "magic") { magicSelect(point); pushHistory(before); return render(); }
		if (state.tool === "text") return openTextDialog(point);
		if (state.tool === "clone") { if (event.altKey || !state.cloneSource) { state.cloneSource = point; showToast("Clone source set. Paint elsewhere to clone"); return; } const cloneSource = makeCanvas(activeAsset().width, activeAsset().height); cloneSource.getContext("2d").drawImage(activeLayer().canvas, activeLayer().offsetX || 0, activeLayer().offsetY || 0); state.gesture = {before, start: point, last: point, points: [point], cloneSource, cloneOffset: {x: state.cloneSource.x - point.x, y: state.cloneSource.y - point.y}}; cloneLine(point, point, state.gesture); return; }
		state.gesture = {before, start: point, last: point, points: [point], layerStart: {x: activeLayer().offsetX || 0, y: activeLayer().offsetY || 0}, selectionStart: activeAsset().selection ? JSON.parse(JSON.stringify(activeAsset().selection)) : null};
		if (["pencil", "brush", "eraser"].includes(state.tool)) paintLine(point, point); else if (state.tool === "recolour") recolourLine(point, point);
	}
	function pointerMove(event) {
		if (!state.gesture) return; const local = pointerPosition(event), point = canvasToSource(local.x, local.y), gesture = state.gesture;
		if (gesture.transform) { updateSelectionTransform(gesture, point, event.shiftKey); gesture.last=point; render(); }
		else if (state.tool === "move") { const layer = activeLayer(), dx = Math.round(point.x - gesture.start.x), dy = Math.round(point.y - gesture.start.y); layer.offsetX = gesture.layerStart.x + dx; layer.offsetY = gesture.layerStart.y + dy; if (gesture.selectionStart?.type === "magic") activeAsset().selection = {...gesture.selectionStart, spans: gesture.selectionStart.spans.map(span => ({...span, x: span.x + dx, y: span.y + dy}))}; else if (gesture.selectionStart) activeAsset().selection = {...gesture.selectionStart, points: gesture.selectionStart.points.map(source => ({x: source.x + dx, y: source.y + dy}))}; gesture.last = point; render(); }
		else if (["pencil", "brush", "eraser"].includes(state.tool)) { paintLine(gesture.last, point); gesture.last = point; render(); }
		else if (state.tool === "clone") { cloneLine(gesture.last, point, gesture); gesture.last = point; render(); }
		else if (state.tool === "recolour") { recolourLine(gesture.last, point); gesture.last = point; render(); }
		else if (state.tool === "select") drawSelection({type: "rect", points: [gesture.start, point]});
		else if (state.tool === "lasso") { gesture.points.push(point); drawSelection({type: "lasso", points: gesture.points}); }
		else drawShapePreview(state.tool, gesture.start, point);
	}
	function pointerUp(event) {
		if (!state.gesture) return; const point = canvasToSource(pointerPosition(event).x, pointerPosition(event).y), gesture = state.gesture; state.gesture = null;
		interactionCanvas.style.cursor = "";
		if (gesture.transform) { pushHistory(gesture.before, gesture.transform === "rotate" ? "Rotate selection" : "Scale selection"); return render(); }
		if (state.tool === "select") combineSelection({type: "rect", points: [gesture.start, point]});
		else if (state.tool === "lasso") { gesture.points.push(point); if (gesture.points.length > 2) combineSelection({type: "lasso", points: gesture.points}); }
		else if (["line", "rectangle", "ellipse"].includes(state.tool)) commitShape(state.tool, gesture.start, point);
		pushHistory(gesture.before); render();
	}

	function clearPixels() {
		const asset = activeAsset(); if (!asset?.selection) return showToast("Make a selection first"); const before = snapshot(), layer = activeLayer(), context = layer.canvas.getContext("2d");
		if (layer.floating) { const target = Math.max(0, Math.min(layer.targetLayer ?? asset.activeLayer - 1, asset.layers.length - 2)); asset.layers.splice(asset.activeLayer, 1); asset.activeLayer = target; asset.selection = null; pushHistory(before, "Delete floating selection"); syncControls(); render(); return; }
		context.save(); context.globalCompositeOperation = "destination-out"; context.drawImage(selectionMask(), -(layer.offsetX || 0), -(layer.offsetY || 0)); context.restore(); asset.selection = null; pushHistory(before, "Delete selected pixels"); render();
	}
	async function copySelection(cut = false) {
		const asset = activeAsset(); if (!asset?.selection) return showToast("Make a selection first"); const bounds = selectionBounds(), layer = activeLayer(), clip = makeCanvas(Math.ceil(bounds.width), Math.ceil(bounds.height)), context = clip.getContext("2d");
		context.drawImage(layer.canvas, (layer.offsetX || 0) - bounds.x, (layer.offsetY || 0) - bounds.y); context.globalCompositeOperation = "destination-in"; context.drawImage(selectionMask(), -bounds.x, -bounds.y); state.clipboard = {canvas: clip, x: bounds.x, y: bounds.y};
		updateActionAvailability();
		if (cut) clearPixels();
		try { const blob = await new Promise(resolve => clip.toBlob(resolve, "image/png")); if (blob && navigator.clipboard?.write && window.ClipboardItem) await navigator.clipboard.write([new ClipboardItem({"image/png": blob})]); } catch {}
		if (!cut) showToast("Selection copied"); else showToast("Selection cut");
	}
	function floatSelection() {
		const asset = activeAsset(); if (!asset?.selection) return showToast("Make a selection first"); if (!canAllocateLayer(asset)) return; const before = snapshot(), sourceIndex = asset.activeLayer, sourceLayer = activeLayer(), mask = selectionMask(), floated = makeCanvas(asset.width, asset.height), floatedContext = floated.getContext("2d"); floatedContext.drawImage(sourceLayer.canvas, sourceLayer.offsetX || 0, sourceLayer.offsetY || 0); floatedContext.globalCompositeOperation = "destination-in"; floatedContext.drawImage(mask, 0, 0);
		const sourceContext = sourceLayer.canvas.getContext("2d"); sourceContext.save(); sourceContext.globalCompositeOperation = "destination-out"; sourceContext.drawImage(mask, -(sourceLayer.offsetX || 0), -(sourceLayer.offsetY || 0)); sourceContext.restore(); asset.layers.push({name: "Floating selection", canvas: floated, visible: true, opacity: 1, blend: "source-over", floating: true, targetLayer: sourceIndex, offsetX: 0, offsetY: 0}); asset.activeLayer = asset.layers.length - 1; pushHistory(before, "Float selected pixels"); selectTool("move", true); syncControls(); render(); showToast("Selection is movable; clear it to stamp");
	}
	function openSelectionResize() { const asset = activeAsset(); if (!asset?.selection) return showToast("Make a selection first"); const bounds = selectionBounds(); $("selectionWidth").value = Math.round(bounds.width); $("selectionHeight").value = Math.round(bounds.height); $("selectionDialog").showModal(); }
	function resizeSelectedPixels() {
		const asset = activeAsset(); if (!asset?.selection) return; if (!canAllocateLayer(asset)) return; const bounds = selectionBounds(), width = Math.max(1, Math.min(16384, +$("selectionWidth").value)), height = Math.max(1, Math.min(16384, +$("selectionHeight").value)); if (!Number.isFinite(width) || !Number.isFinite(height) || width * height > 80000000) return showToast("Choose a smaller selection size"); const before = snapshot(), sourceIndex = asset.activeLayer, sourceLayer = activeLayer(), mask = selectionMask(), clipped = makeCanvas(Math.ceil(bounds.width), Math.ceil(bounds.height)), clippedContext = clipped.getContext("2d"); clippedContext.drawImage(sourceLayer.canvas, (sourceLayer.offsetX || 0) - bounds.x, (sourceLayer.offsetY || 0) - bounds.y); clippedContext.globalCompositeOperation = "destination-in"; clippedContext.drawImage(mask, -bounds.x, -bounds.y); const sourceContext = sourceLayer.canvas.getContext("2d"); sourceContext.save(); sourceContext.globalCompositeOperation = "destination-out"; sourceContext.drawImage(mask, -(sourceLayer.offsetX || 0), -(sourceLayer.offsetY || 0)); sourceContext.restore(); const resized = makeCanvas(asset.width, asset.height), resizedContext = resized.getContext("2d"); resizedContext.drawImage(clipped, 0, 0, clipped.width, clipped.height, bounds.x, bounds.y, width, height); asset.layers.push({name: "Resized selection", canvas: resized, visible: true, opacity: 1, blend: "source-over", floating: true, targetLayer: sourceIndex, offsetX: 0, offsetY: 0}); asset.activeLayer = asset.layers.length - 1; asset.selection = {type: "rect", points: [{x: bounds.x, y: bounds.y}, {x: bounds.x + width, y: bounds.y + height}]}; pushHistory(before, "Resize selected pixels"); $("selectionDialog").close(); selectTool("move", true); syncControls(); render();
	}
	function pasteCanvas(source, x, y, name = "Pasted selection") {
		const asset = activeAsset(); if (!canAllocateLayer(asset)) return; const before = snapshot(), layerCanvas = makeCanvas(asset.width, asset.height); layerCanvas.getContext("2d").drawImage(source, Math.round(x), Math.round(y));
		asset.layers.push({name, canvas: layerCanvas, visible: true, opacity: 1, blend: "source-over", floating: true, targetLayer: asset.activeLayer}); asset.activeLayer = asset.layers.length - 1; asset.selection = {type: "rect", points: [{x, y}, {x: x + source.width, y: y + source.height}]}; pushHistory(before, "Paste"); selectTool("move", true); syncControls(); render(); showToast("Pasted as new movable layer");
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
			const row = document.createElement("div"); row.className = "layer-row" + (index === asset.activeLayer ? " active" : ""); row.draggable = true;
			row.addEventListener("dragstart", event => { event.dataTransfer.setData("text/plain", String(index)); event.dataTransfer.effectAllowed = "move"; row.classList.add("dragging"); });
			row.addEventListener("dragend", () => row.classList.remove("dragging")); row.addEventListener("dragover", event => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; row.classList.add("drag-over"); });
			row.addEventListener("dragleave", () => row.classList.remove("drag-over")); row.addEventListener("drop", event => { event.preventDefault(); row.classList.remove("drag-over"); const from = Number(event.dataTransfer.getData("text/plain")); if (!Number.isInteger(from) || from === index) return; mutate(current => { const [moved] = current.layers.splice(from, 1); current.layers.splice(index, 0, moved); current.activeLayer = index; }); });
			const visible = document.createElement("button"); visible.type = "button"; visible.className = "layer-visible"; visible.textContent = layer.visible ? "●" : "○"; visible.title = layer.visible ? "Hide layer" : "Show layer";
			visible.addEventListener("click", event => { event.stopPropagation(); mutate(current => current.layers[index].visible = !current.layers[index].visible); });
			const name = document.createElement("span"); name.textContent = layer.name;
			name.addEventListener("dblclick", event => { event.stopPropagation(); const before = snapshot(); name.contentEditable = "true"; name.focus(); document.getSelection()?.selectAllChildren(name); const finish = () => { name.contentEditable = "false"; layer.name = name.textContent.trim() || "Layer"; pushHistory(before); renderLayers(); }; name.addEventListener("blur", finish, {once: true}); name.addEventListener("keydown", keyEvent => { if (keyEvent.key === "Enter") { keyEvent.preventDefault(); name.blur(); } }); });
			const opacity = document.createElement("span"); opacity.className = "layer-row-opacity"; opacity.textContent = Math.round(layer.opacity * 100) + "%";
			row.append(visible, name, opacity); row.addEventListener("click", () => { asset.activeLayer = index; renderLayers(); }); return row;
		}).reverse());
			const layer = activeLayer(); if (layer) { $("layerOpacity").value = Math.round(layer.opacity * 100); $("layerOpacityValue").value = Math.round(layer.opacity * 100); }
		if (layer) $("layerBlend").value = layer.blend || "source-over";
	}
	function addLayer(name = "Layer " + (activeAsset().layers.length + 1)) { if (!canAllocateLayer()) return; mutate(asset => { asset.layers.push({name, canvas: makeCanvas(asset.width, asset.height), visible: true, opacity: 1, blend: "source-over"}); asset.activeLayer = asset.layers.length - 1; }); }
	function duplicateLayer() { const layer = activeLayer(); if (!layer) return; mutate(asset => { const copy = makeCanvas(asset.width, asset.height); copy.getContext("2d").drawImage(layer.canvas, 0, 0); asset.layers.splice(asset.activeLayer + 1, 0, {...layer, name: layer.name + " copy", canvas: copy}); asset.activeLayer++; }); }
	function moveLayer(delta) { const asset = activeAsset(), next = asset.activeLayer + delta; if (next < 0 || next >= asset.layers.length) return; mutate(current => { [current.layers[current.activeLayer], current.layers[next]] = [current.layers[next], current.layers[current.activeLayer]]; current.activeLayer = next; }); }
	function mergeLayerDown() {
		const asset = activeAsset(); if (asset.activeLayer < 1) return showToast("There is no layer below this one");
		mutate(current => { const index = current.activeLayer, upper = current.layers[index], lower = current.layers[index - 1], context = lower.canvas.getContext("2d"); if (upper.visible) { context.save(); context.globalAlpha = upper.opacity; context.globalCompositeOperation = upper.blend || "source-over"; context.drawImage(upper.canvas, (upper.offsetX || 0) - (lower.offsetX || 0), (upper.offsetY || 0) - (lower.offsetY || 0)); context.restore(); } current.layers.splice(index, 1); current.activeLayer = index - 1; current.selection = null; });
	}
	function resizeCanvas() {
		const asset = activeAsset(), width = Math.max(1, Math.min(16384, +$("canvasWidth").value)), height = Math.max(1, Math.min(16384, +$("canvasHeight").value)); if (!Number.isFinite(width) || !Number.isFinite(height) || width * height > 80000000) return showToast("Choose a canvas no larger than 80 megapixels"); const before = snapshot(), centred = $("canvasAnchor").value === "centre", dx = centred ? Math.round((width - asset.width) / 2) : 0, dy = centred ? Math.round((height - asset.height) / 2) : 0;
		asset.layers = asset.layers.map(layer => { const resized = makeCanvas(width, height); resized.getContext("2d").drawImage(layer.canvas, (layer.offsetX || 0) + dx, (layer.offsetY || 0) + dy); return {...layer, canvas: resized, offsetX: 0, offsetY: 0}; }); asset.width = width; asset.height = height; asset.edit.crop = {x: 0, y: 0, width, height}; asset.selection = null; pushHistory(before, "Resize canvas"); $("canvasDialog").close(); state.zoom = 0; syncControls(); render();
	}
	function applyEffect(kind) {
		const asset = activeAsset(), layer = activeLayer(); if (!asset || !layer) return; if (asset.width * asset.height > 40000000) return showToast("This effect is disabled above 40 megapixels"); const before = snapshot(), context = layer.canvas.getContext("2d"), image = context.getImageData(0, 0, asset.width, asset.height), data = image.data;
		if (["grayscale", "sepia", "noise", "levels"].includes(kind)) { const black = Math.min(254, +$("levelBlack").value), white = Math.max(black + 1, +$("levelWhite").value), gamma = Math.max(.1, +$("levelGamma").value); for (let i = 0; i < data.length; i += 4) { if (kind === "grayscale") { const light = Math.round(data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722); data[i] = data[i + 1] = data[i + 2] = light; } else if (kind === "sepia") { const r = data[i], g = data[i + 1], b = data[i + 2]; data[i] = Math.min(255, r * .393 + g * .769 + b * .189); data[i + 1] = Math.min(255, r * .349 + g * .686 + b * .168); data[i + 2] = Math.min(255, r * .272 + g * .534 + b * .131); } else if (kind === "noise") { const amount = (Math.random() - .5) * 36; data[i] += amount; data[i + 1] += amount; data[i + 2] += amount; } else for (let channel = 0; channel < 3; channel++) data[i + channel] = 255 * Math.pow(Math.max(0, Math.min(1, (data[i + channel] - black) / (white - black))), 1 / gamma); } context.putImageData(image, 0, 0); }
		if (kind === "pixelate") { const block = Math.max(2, Math.round(Math.min(asset.width, asset.height) / 100)), small = makeCanvas(Math.max(1, Math.ceil(asset.width / block)), Math.max(1, Math.ceil(asset.height / block))), smallContext = small.getContext("2d"); smallContext.imageSmoothingEnabled = false; smallContext.drawImage(layer.canvas, 0, 0, small.width, small.height); context.clearRect(0, 0, asset.width, asset.height); context.imageSmoothingEnabled = false; context.drawImage(small, 0, 0, small.width, small.height, 0, 0, asset.width, asset.height); context.imageSmoothingEnabled = true; }
		if (kind === "distort") { const source = makeCanvas(asset.width, asset.height); source.getContext("2d").drawImage(layer.canvas, 0, 0); context.clearRect(0, 0, asset.width, asset.height); const amplitude = Math.max(2, Math.round(asset.width / 100)), period = Math.max(12, Math.round(asset.height / 12)); for (let y = 0; y < asset.height; y++) context.drawImage(source, 0, y, asset.width, 1, Math.round(Math.sin(y / period * Math.PI * 2) * amplitude), y, asset.width, 1); }
		pushHistory(before, kind[0].toUpperCase() + kind.slice(1)); render();
	}
	function projectData() { return {format: "pict", version: 1, savedAt: new Date().toISOString(), active: state.active, assets: state.assets.map(asset => ({name: asset.file.name, type: asset.file.type, width: asset.width, height: asset.height, edit: asset.edit, selection: asset.selection, activeLayer: asset.activeLayer, layers: asset.layers.map(layer => ({name: layer.name, visible: layer.visible, opacity: layer.opacity, blend: layer.blend || "source-over", floating: Boolean(layer.floating), targetLayer: layer.targetLayer, offsetX: layer.offsetX || 0, offsetY: layer.offsetY || 0, data: layer.canvas.toDataURL("image/png")}))}))}; }
	async function loadProject(data) {
		if (data?.format !== "pict" || data.version !== 1 || !Array.isArray(data.assets)) throw new Error("Not a Pict project"); const assets = []; for (const saved of data.assets) { if (!saved.width || !saved.height || saved.width * saved.height > 40000000 || !Array.isArray(saved.layers) || !saved.layers.length || saved.width * saved.height * saved.layers.length > 96000000 || saved.layers.some(layer => typeof layer.data !== "string" || !layer.data.startsWith("data:image/png;base64,"))) throw new Error("Unsafe project dimensions"); const layers = await Promise.all(saved.layers.map(async layer => ({...layer, canvas: await canvasFromURL(layer.data, saved.width, saved.height)}))), composite = makeCanvas(saved.width, saved.height), compositeContext = composite.getContext("2d"); for (const layer of layers) if (layer.visible) { compositeContext.globalAlpha = layer.opacity; compositeContext.globalCompositeOperation = layer.blend || "source-over"; compositeContext.drawImage(layer.canvas, layer.offsetX || 0, layer.offsetY || 0); } const url = composite.toDataURL("image/png"), image = new Image(); image.src = url; await image.decode(); const file = new File([], saved.name || "project-image.png", {type: saved.type || "image/png"}); assets.push({file, image, url, width: saved.width, height: saved.height, edit: saved.edit, selection: saved.selection || null, activeLayer: Math.min(saved.activeLayer || 0, layers.length - 1), layers}); }
		state.assets.forEach(asset => { if (asset.url.startsWith("blob:")) URL.revokeObjectURL(asset.url); }); state.assets = assets; state.active = Math.max(0, Math.min(data.active || 0, assets.length - 1)); state.history = []; state.future = []; $("emptyState").hidden = Boolean(assets.length); $("editor").hidden = !assets.length; if (assets.length) selectAsset(state.active); showToast("Pict project opened");
	}
	function saveProject() { if (!state.assets.length) return; const blob = new Blob([JSON.stringify(projectData())], {type: "application/json"}); download(blob, cleanName(activeAsset().file.name) + ".pict"); showToast("Pict project saved"); }
	function openDraftDatabase() { return new Promise((resolve, reject) => { const request = indexedDB.open("pict", 1); request.onupgradeneeded = () => request.result.createObjectStore("drafts"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
	async function writeDraft() { if (!state.assets.length || state.assets.reduce((sum, asset) => sum + asset.width * asset.height * asset.layers.length, 0) > 32000000) return; try { const db = await openDraftDatabase(), transaction = db.transaction("drafts", "readwrite"); transaction.objectStore("drafts").put(projectData(), "latest"); transaction.oncomplete = () => db.close(); } catch {} }
	function scheduleDraftSave() { clearTimeout(state.draftTimer); state.draftTimer = setTimeout(writeDraft, 1500); }
	async function recoverDraft() { try { const db = await openDraftDatabase(), request = db.transaction("drafts").objectStore("drafts").get("latest"); request.onsuccess = async () => { db.close(); if (!request.result) return showToast("No recovery draft found"); try { await loadProject(request.result); } catch { showToast("The recovery draft could not be opened"); } }; } catch { showToast("Draft recovery is unavailable"); } }

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
	const imageSections = {transform: $("transformSection"), crop: $("cropSection"), adjust: $("adjustSection")};
	function openImageDialog(kind) {
		const titles = {transform: "Transform image", crop: "Crop image", adjust: "Adjust image"}; $("imageDialogTitle").textContent = titles[kind]; $("imageDialogBody").replaceChildren(imageSections[kind]); $("imageDialog").showModal();
	}
	function closeMenus() { document.querySelectorAll(".app-menu").forEach(menu => menu.classList.remove("show")); document.querySelectorAll(".menu-trigger").forEach(button => button.setAttribute("aria-expanded", "false")); }
	function showMenu(button) { const menu = $(button.dataset.menu), rect = button.getBoundingClientRect(); closeMenus(); menu.style.left = rect.left + "px"; menu.style.top = rect.bottom + "px"; menu.classList.add("show"); button.setAttribute("aria-expanded", "true"); }
	function nudgeVector(key, amount) { return {x: key === "ArrowLeft" ? -amount : key === "ArrowRight" ? amount : 0, y: key === "ArrowUp" ? -amount : key === "ArrowDown" ? amount : 0}; }
	function nudgeFrame(time) {
		const nudge = state.nudge; if (!nudge) return; const held = time - nudge.started, elapsed = time - nudge.last; nudge.last = time;
		if (held > 240) { const rate = held > 1500 ? 320 : held > 800 ? 190 : 90; nudge.remainder += elapsed * rate / 1000; const amount = Math.floor(nudge.remainder); if (amount) { nudge.remainder -= amount; const vector = nudgeVector(nudge.key, amount); shiftActiveLayer(vector.x, vector.y); render(); } }
		nudge.frame = requestAnimationFrame(nudgeFrame);
	}
	function startNudge(event) {
		if (state.nudge || event.repeat) return; const before = snapshot(), amount = event.shiftKey ? 10 : 1, vector = nudgeVector(event.key, amount); shiftActiveLayer(vector.x, vector.y); render();
		state.nudge = {key: event.key, before, started: performance.now(), last: performance.now(), remainder: 0, frame: requestAnimationFrame(nudgeFrame)};
	}
	function stopNudge(event) {
		if (!state.nudge || event.key !== state.nudge.key) return; cancelAnimationFrame(state.nudge.frame); const before = state.nudge.before; state.nudge = null; pushHistory(before);
	}
	["emptyOpenButton", "addButton"].forEach(id => $(id).addEventListener("click", () => $("fileInput").click()));
	$("fileInput").addEventListener("change", event => { loadFiles(event.target.files); event.target.value = ""; });
	$("projectInput").addEventListener("change", async event => { const file = event.target.files[0]; event.target.value = ""; if (!file) return; try { await loadProject(JSON.parse(await file.text())); } catch { showToast("That is not a valid Pict project"); } });
	document.addEventListener("paste", event => { const files = [...event.clipboardData.items].filter(item => item.kind === "file").map(item => item.getAsFile()); if (!files.length) return; event.preventDefault(); if (!activeAsset()) loadFiles(files); else decodeFile(files[0]).then(({image, url}) => { pasteCanvas(image, activeAsset().edit.crop.x, activeAsset().edit.crop.y, "Pasted image"); URL.revokeObjectURL(url); }); });
	["dragenter", "dragover"].forEach(type => document.addEventListener(type, event => { event.preventDefault(); if (!$("editor").hidden) $("canvasStage").classList.add("dragging"); }));
	["dragleave", "drop"].forEach(type => document.addEventListener(type, event => { event.preventDefault(); $("canvasStage").classList.remove("dragging"); }));
	document.addEventListener("drop", event => loadFiles(event.dataTransfer.files));
	document.querySelectorAll(".left-tab").forEach(button => button.addEventListener("click", () => { document.querySelectorAll(".left-tab").forEach(tab => { const active = tab === button; tab.classList.toggle("active", active); tab.setAttribute("aria-selected", active); }); $("toolsPanel").hidden = button.dataset.leftTab !== "tools"; $("imagesPanel").hidden = button.dataset.leftTab !== "images"; }));
	document.querySelectorAll(".paint-tool").forEach(button => button.addEventListener("click", () => selectTool(button.dataset.tool)));
	document.querySelectorAll(".tab").forEach(button => button.addEventListener("click", () => showTab(button.dataset.tab)));
	document.querySelectorAll(".menu-trigger").forEach(button => {
		button.addEventListener("click", event => { event.stopPropagation(); const opening = !$(button.dataset.menu).classList.contains("show"); closeMenus(); if (opening) showMenu(button); });
		button.addEventListener("pointerenter", () => { if (document.querySelector(".app-menu.show") && !$(button.dataset.menu).classList.contains("show")) showMenu(button); });
	});
	document.addEventListener("click", event => { if (!event.target.closest(".app-menu,.menu-trigger")) closeMenus(); });
	document.querySelectorAll(".app-menu [data-action]").forEach(button => button.addEventListener("click", () => {
		closeMenus(); const action = button.dataset.action;
		if (action === "open") $("fileInput").click(); if (action === "open-project") $("projectInput").click(); if (action === "save-project") saveProject(); if (action === "recover") recoverDraft(); if (action === "export" && activeAsset()) showTab("export"); if (action === "undo") undo(); if (action === "redo") redo(); if (action === "select-all" && activeAsset()) { activeAsset().selection = {type: "rect", points: [{x: 0, y: 0}, {x: activeAsset().width, y: activeAsset().height}]}; render(); } if (action === "deselect") clearSelectionAndCommit(); if (action === "copy") copySelection(); if (action === "cut") copySelection(true); if (action === "paste") pasteSelection(); if (["transform", "crop", "adjust"].includes(action) && activeAsset()) openImageDialog(action); if (action === "canvas-size" && activeAsset()) { $("canvasWidth").value = activeAsset().width; $("canvasHeight").value = activeAsset().height; $("canvasDialog").showModal(); } if (action === "effects" && activeAsset()) $("effectsDialog").showModal();
	}));
	document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => $(button.dataset.close).close()));
	interactionCanvas.addEventListener("pointerdown", pointerDown); interactionCanvas.addEventListener("pointermove", pointerMove); interactionCanvas.addEventListener("pointerup", pointerUp); interactionCanvas.addEventListener("pointercancel", pointerUp);
	$("canvasStage").addEventListener("wheel", event => { if (!event.target.closest("#canvasWrap") || !activeAsset()) return; event.preventDefault(); const crop = activeAsset().edit.crop, current = state.zoom || canvas.width / (Math.abs(activeAsset().edit.rotation % 180) === 90 ? crop.height : crop.width); state.zoom = Math.max(.05, Math.min(8, current * (event.deltaY < 0 ? 1.12 : .89))); render(); }, {passive: false});
	interactionCanvas.addEventListener("contextmenu", event => { event.preventDefault(); $("contextMenu").style.left = event.clientX + "px"; $("contextMenu").style.top = event.clientY + "px"; $("contextMenu").classList.add("show"); });
	document.addEventListener("pointerdown", event => { if (!event.target.closest("#contextMenu")) $("contextMenu").classList.remove("show"); });
	document.querySelectorAll("#contextMenu [data-command]").forEach(button => button.addEventListener("click", () => { const command = button.dataset.command; $("contextMenu").classList.remove("show"); if (command === "copy") copySelection(); if (command === "cut") copySelection(true); if (command === "paste") pasteSelection(); if (command === "delete") clearPixels(); if (command === "clear") clearSelectionAndCommit(); }));
	$("undoButton").addEventListener("click", undo); $("redoButton").addEventListener("click", redo);
	$("clearSelection").addEventListener("click", clearSelectionAndCommit); $("deleteSelection").addEventListener("click", clearPixels);
	$("invertSelection").addEventListener("click", invertSelection); $("floatSelection").addEventListener("click", floatSelection); $("resizeSelection").addEventListener("click", openSelectionResize); $("applySelectionSize").addEventListener("click", resizeSelectedPixels);
	$("cropToSelection").addEventListener("click", () => { if (!activeAsset()?.selection) return showToast("Make a selection first"); mutate(asset => { asset.edit.crop = selectionBounds(); asset.selection = null; }); });
	$("resetButton").addEventListener("click", () => mutate(asset => { const base = makeCanvas(asset.width, asset.height); base.getContext("2d").drawImage(asset.image, 0, 0); asset.edit = defaultEdit(asset.image); asset.selection = null; asset.layers = [{name: "Background", canvas: base, visible: true, opacity: 1, blend: "source-over"}]; asset.activeLayer = 0; }));
	$("rotateLeft").addEventListener("click", () => mutate(asset => asset.edit.rotation = (asset.edit.rotation + 270) % 360)); $("rotateRight").addEventListener("click", () => mutate(asset => asset.edit.rotation = (asset.edit.rotation + 90) % 360));
	$("flipHorizontal").addEventListener("click", () => mutate(asset => asset.edit.flipX = !asset.edit.flipX)); $("flipVertical").addEventListener("click", () => mutate(asset => asset.edit.flipY = !asset.edit.flipY));
	$("resetCrop").addEventListener("click", () => mutate(asset => asset.edit.crop = {x: 0, y: 0, width: asset.width, height: asset.height}));
	["cropX", "cropY", "cropWidth", "cropHeight"].forEach(id => $(id).addEventListener("change", () => { const crop = validCrop(); if (crop) mutate(asset => asset.edit.crop = crop); }));
	$("applyAspect").addEventListener("click", () => { const ratio = +$("aspectRatio").value; if (!ratio) return; mutate(asset => { let width = asset.width, height = width / ratio; if (height > asset.height) { height = asset.height; width = height * ratio; } asset.edit.crop = {x: (asset.width - width) / 2, y: (asset.height - height) / 2, width, height}; }); });
	adjustmentIds.forEach(id => { let before; const remember = () => { if (!before) before = snapshot(); }; $(id).addEventListener("pointerdown", () => before = snapshot()); $(id).addEventListener("keydown", remember); $(id).addEventListener("input", () => { remember(); activeAsset().edit[id] = +$(id).value; $(id + "Value").value = $(id).value; render(); }); $(id).addEventListener("change", () => { pushHistory(before); before = null; syncControls(); }); });
	$("resetAdjustments").addEventListener("click", () => mutate(asset => adjustmentIds.forEach(id => asset.edit[id] = 0)));
	$("fillTolerance").addEventListener("input", () => $("toleranceValue").value = $("fillTolerance").value);
	$("toolOpacity").addEventListener("input", () => $("toolOpacityValue").value = $("toolOpacity").value);
	$("brushHardness").addEventListener("input", () => $("brushHardnessValue").value = $("brushHardness").value); $("brushSpacing").addEventListener("input", () => $("brushSpacingValue").value = $("brushSpacing").value); $("selectionFeather").addEventListener("input", () => $("featherValue").value = $("selectionFeather").value);
	$("colourSwatch").addEventListener("click", openColourDialog); $("hueRange").addEventListener("input", () => { syncColourInputs(hsvToRgb({h: +$("hueRange").value, s: +$("saturationInput").value, v: +$("valueInput").value})); drawColourField(); }); $("colourField").addEventListener("pointerdown", sampleColourField); $("colourField").addEventListener("pointermove", event => { if (event.buttons === 1) sampleColourField(event); });
	$("hexInput").addEventListener("change", () => { const parsed = parseColour($("hexInput").value); if (!parsed) return $("hexInput").setAttribute("aria-invalid", "true"); $("hexInput").removeAttribute("aria-invalid"); syncColourInputs(hexToRgb(parsed.hex)); drawColourField(); });
	["redInput", "greenInput", "blueInput"].forEach(id => $(id).addEventListener("change", () => { syncColourInputs({r: +$("redInput").value, g: +$("greenInput").value, b: +$("blueInput").value}); drawColourField(); }));
	["hueInput", "saturationInput", "valueInput"].forEach(id => $(id).addEventListener("change", () => { syncColourInputs(hsvToRgb({h: +$("hueInput").value, s: +$("saturationInput").value, v: +$("valueInput").value})); drawColourField(); }));
	$("applyColour").addEventListener("click", () => { if (!setColour($("hexInput").value)) return showToast("Enter a valid hex colour"); $("colourDialog").close(); });
	$("colourDialog").addEventListener("close", () => $("colourSwatch").style.background = state.colour);
	$("applyText").addEventListener("click", applyText);
	$("addLayer").addEventListener("click", () => addLayer()); $("duplicateLayer").addEventListener("click", duplicateLayer); $("deleteLayer").addEventListener("click", () => { if (activeAsset().layers.length === 1) return showToast("An image needs at least one layer"); mutate(asset => { asset.layers.splice(asset.activeLayer, 1); asset.activeLayer = Math.max(0, asset.activeLayer - 1); }); });
	$("mergeLayer").addEventListener("click", mergeLayerDown);
	$("layerUp").addEventListener("click", () => moveLayer(1)); $("layerDown").addEventListener("click", () => moveLayer(-1)); let layerBefore;
	$("layerOpacity").addEventListener("pointerdown", () => layerBefore = snapshot()); $("layerOpacity").addEventListener("input", () => { activeLayer().opacity = +$("layerOpacity").value / 100; $("layerOpacityValue").value = $("layerOpacity").value; renderLayers(); render(); }); $("layerOpacity").addEventListener("change", () => { pushHistory(layerBefore); layerBefore = null; });
	$("layerBlend").addEventListener("change", () => mutate(asset => asset.layers[asset.activeLayer].blend = $("layerBlend").value));
	$("clearHistory").addEventListener("click", () => { state.history = []; state.future = []; updateHistoryButtons(); });
	$("gridToggle").addEventListener("click", () => { state.grid = !state.grid; $("gridToggle").classList.toggle("active", state.grid); drawSelection(); });
	$("applyCanvasSize").addEventListener("click", resizeCanvas); document.querySelectorAll("[data-effect]").forEach(button => button.addEventListener("click", () => { closeMenus(); if (!activeAsset()) return showToast("Open an image first"); applyEffect(button.dataset.effect); if (button.dataset.effect === "levels") $("effectsDialog").close(); }));
	$("zoomIn").addEventListener("click", () => { state.zoom = Math.min(4, (state.zoom || canvas.width / activeAsset().edit.crop.width) * 1.25); render(); }); $("zoomOut").addEventListener("click", () => { state.zoom = Math.max(.05, (state.zoom || canvas.width / activeAsset().edit.crop.width) / 1.25); render(); });
	$("applyRotation").addEventListener("click", () => mutate(asset => asset.edit.rotation = ((+$("rotationAngle").value % 360) + 360) % 360));
	$("exportWidth").addEventListener("change", () => { if ($("lockRatio").checked) $("exportHeight").value = outputDimensions(+$("exportWidth").value)[1]; }); $("exportHeight").addEventListener("change", () => { if ($("lockRatio").checked) $("exportWidth").value = Math.round(+$("exportHeight").value * activeAsset().edit.crop.width / activeAsset().edit.crop.height); });
	$("exportFormat").addEventListener("change", () => { $("qualityLabel").hidden = $("exportFormat").value === "image/png"; updateMarkup(); }); $("quality").addEventListener("input", () => $("qualityValue").value = $("quality").value);
	$("exportName").addEventListener("input", updateMarkup); document.querySelectorAll("[name=variant]").forEach(input => input.addEventListener("change", updateMarkup)); $("exportButton").addEventListener("click", exportImage); $("variantsButton").addEventListener("click", exportVariants);
	$("copyMarkup").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("markupOutput").value); showToast("Markup copied"); } catch { $("markupOutput").select(); document.execCommand("copy"); showToast("Markup copied"); } });
	document.addEventListener("keydown", event => {
		if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return; const key = event.key.toLowerCase(), modifier = event.ctrlKey || event.metaKey;
		if (modifier && key === "o") { event.preventDefault(); return $("fileInput").click(); } if (!activeAsset()) return;
		if (modifier && event.shiftKey && key === "s") { event.preventDefault(); return saveProject(); }
		if (modifier && key === "a") { event.preventDefault(); if (event.shiftKey) return clearSelectionAndCommit(); activeAsset().selection = {type: "rect", points: [{x: 0, y: 0}, {x: activeAsset().width, y: activeAsset().height}]}; return render(); }
		if (modifier && key === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); } else if (modifier && key === "y") { event.preventDefault(); redo(); } else if (modifier && key === "c") { event.preventDefault(); copySelection(); } else if (modifier && key === "x") { event.preventDefault(); copySelection(true); } else if (modifier && key === "v") { event.preventDefault(); pasteSelection(); } else if (modifier && key === "e") { event.preventDefault(); showTab("export"); } else if (state.tool === "move" && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); startNudge(event); } else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); clearPixels(); } else if (event.key === "Escape") { clearSelectionAndCommit(); }
	});
	document.addEventListener("keyup", stopNudge);
	window.addEventListener("resize", () => { if (activeAsset() && !state.zoom) render(); });
	renderPalette(); setColour(colours[0]);
})();
