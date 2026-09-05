const TRANSFORMERS_URLS = [
	"https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.mjs",
	"https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/+esm",
	"https://unpkg.com/@huggingface/transformers@3.8.1/dist/transformers.min.mjs"
];
const models = new Map();
let library;

async function transformers(report = () => {}) {
	if (!library) {
		let lastError;
		for (const url of TRANSFORMERS_URLS) {
			try { report({phase: "Loading AI engine", value: 1, detail: new URL(url).hostname}); library = await import(url); break; }
			catch (error) { lastError = error; }
		}
		if (!library) throw new Error("AI engine download failed: " + (lastError?.message || "network request blocked"));
		library.env.allowLocalModels = false;
		// Some privacy-focused browsers expose CacheStorage but reject library access.
		// Keep model instances for this session without making CacheStorage mandatory.
		library.env.useBrowserCache = false;
	}
	return library;
}

function progressReporter(report) {
	return item => {
		if (item.status === "progress") report({phase: "Downloading model", value: item.progress || 0, detail: item.file || "Model weights"});
		else if (item.status === "ready") report({phase: "Model ready", value: 100, detail: "Running locally"});
		else if (item.status === "initiate") report({phase: "Loading model", value: 4, detail: item.file || "Preparing files"});
	};
}

async function getPipeline(key, task, model, report) {
	if (!models.has(key)) {
		const {pipeline} = await transformers(report), progress_callback = progressReporter(report);
		models.set(key, pipeline(task, model, {dtype: "q8", progress_callback}).catch(async firstError => {
			report({phase: "Trying compatible model", value: 1, detail: "The compact weights are unavailable; trying the standard model"});
			try { return await pipeline(task, model, {dtype: "fp32", progress_callback}); }
			catch (secondError) { models.delete(key); throw new Error(`${model}: ${secondError.message || firstError.message || "model load failed"}`); }
		}));
	}
	return models.get(key);
}

function canvasURL(canvas) {
	return new Promise((resolve, reject) => canvas.toBlob(blob => {
		if (!blob) reject(new Error("Could not prepare image"));
		else resolve(URL.createObjectURL(blob));
	}, "image/png"));
}

function rawCanvas(raw) {
	if (raw.toCanvas) return raw.toCanvas();
	const output = document.createElement("canvas"); output.width = raw.width; output.height = raw.height;
	const data = new Uint8ClampedArray(raw.width * raw.height * 4);
	for (let pixel = 0, source = 0; pixel < data.length; pixel += 4) {
		data[pixel] = raw.data[source++]; data[pixel + 1] = raw.channels > 1 ? raw.data[source++] : data[pixel]; data[pixel + 2] = raw.channels > 2 ? raw.data[source++] : data[pixel]; data[pixel + 3] = raw.channels > 3 ? raw.data[source++] : 255;
	}
	output.getContext("2d").putImageData(new ImageData(data, raw.width, raw.height), 0, 0); return output;
}

function resizeCanvas(source, width, height) {
	const output = document.createElement("canvas"); output.width = width; output.height = height;
	const context = output.getContext("2d"); context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high"; context.drawImage(source, 0, 0, width, height); return output;
}

async function imageToImage(source, model, report) {
	const pipe = await getPipeline(model, "image-to-image", model, report), url = await canvasURL(source);
	try { report({phase: "Analysing pixels", value: 100, detail: "The model is running on this device"}); return rawCanvas(await pipe(url)); }
	finally { URL.revokeObjectURL(url); }
}

async function removeBackground(source, report) {
	const pipe = await getPipeline("modnet", "background-removal", "Xenova/modnet", report), url = await canvasURL(source);
	try {
		report({phase: "Finding the subject", value: 100, detail: "Refining transparent edges"});
		const result = await pipe(url), mask = rawCanvas(result[0]), output = resizeCanvas(source, source.width, source.height), context = output.getContext("2d");
		context.globalCompositeOperation = "destination-in"; context.drawImage(mask, 0, 0, source.width, source.height); return output;
	} finally { URL.revokeObjectURL(url); }
}

const semanticColours = {
	sky: [116, 171, 214], water: [64, 137, 169], sea: [52, 126, 158], river: [55, 133, 158], grass: [93, 137, 74], plant: [82, 132, 74], tree: [71, 112, 63], flower: [201, 117, 138], earth: [133, 102, 74], road: [109, 102, 96], building: [161, 125, 105], wall: [153, 126, 110], wood: [143, 104, 71], person: [190, 135, 113], face: [205, 151, 125], skin: [205, 151, 125], hair: [73, 54, 46], cloth: [124, 101, 151], car: [151, 76, 70], food: [191, 132, 67]
};
function labelColour(label) {
	const text = label.toLowerCase(); for (const [key, colour] of Object.entries(semanticColours)) if (text.includes(key)) return colour;
	let hash = 0; for (const character of text) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
	return [95 + hash % 90, 90 + (hash >>> 8) % 95, 90 + (hash >>> 16) % 95];
}
async function colourise(source, report) {
	const pipe = await getPipeline("semantic-colour", "image-segmentation", "Xenova/segformer-b0-finetuned-ade-512-512", report), url = await canvasURL(source);
	try {
		report({phase: "Understanding the scene", value: 100, detail: "Assigning colour by subject and material"}); const segments = await pipe(url);
		const output = resizeCanvas(source, source.width, source.height), context = output.getContext("2d"), base = context.getImageData(0, 0, output.width, output.height), pixels = base.data;
		for (const segment of segments) {
			const maskCanvas = resizeCanvas(rawCanvas(segment.mask), output.width, output.height), mask = maskCanvas.getContext("2d").getImageData(0, 0, output.width, output.height).data, colour = labelColour(segment.label || "scene");
			for (let i = 0; i < pixels.length; i += 4) if (mask[i] > 55 || mask[i + 3] > 55) {
				const strength = Math.max(mask[i], mask[i + 3]) / 255 * .62, light = pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722;
				for (let c = 0; c < 3; c++) pixels[i + c] = pixels[i + c] * (1 - strength) + Math.min(255, colour[c] * (.38 + light / 210)) * strength;
			}
		}
		context.putImageData(base, 0, 0); return output;
	} finally { URL.revokeObjectURL(url); }
}

function repairSpecks(source) {
	const output = resizeCanvas(source, source.width, source.height), context = output.getContext("2d"), image = context.getImageData(0, 0, output.width, output.height), copy = new Uint8ClampedArray(image.data), width = output.width;
	for (let y = 1; y < output.height - 1; y++) for (let x = 1; x < width - 1; x++) {
		const i = (y * width + x) * 4, neighbours = [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1].map(offset => { const p = i + offset * 4; return copy[p] * .2126 + copy[p + 1] * .7152 + copy[p + 2] * .0722; }).sort((a,b) => a-b), centre = copy[i] * .2126 + copy[i + 1] * .7152 + copy[i + 2] * .0722, median = (neighbours[3] + neighbours[4]) / 2;
		if (Math.abs(centre - median) > 92) for (let c = 0; c < 3; c++) image.data[i + c] = Math.round(copy[i + c] * .15 + median * .85);
	}
	context.putImageData(image, 0, 0); return output;
}

async function restore(source, report) {
	report({phase: "Repairing damage", value: 2, detail: "Removing isolated dust and scratches"});
	const cleaned = repairSpecks(source), enhanced = await imageToImage(cleaned, "Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr", report); return resizeCanvas(enhanced, source.width, source.height);
}
async function denoise(source, report) {
	const maxSide = Math.max(source.width, source.height), scale = Math.min(1, 720 / maxSide), input = resizeCanvas(source, Math.max(16, Math.round(source.width * scale)), Math.max(16, Math.round(source.height * scale)));
	const enhanced = await imageToImage(input, "Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr", report); return resizeCanvas(enhanced, source.width, source.height);
}

window.PictAI = {
	async run(kind, source, report = () => {}) {
		if (kind === "background") return removeBackground(source, report);
		if (kind === "upscale") return imageToImage(source, "Xenova/swin2SR-classical-sr-x2-64", report);
		if (kind === "colourise") return colourise(source, report);
		if (kind === "restore") return restore(source, report);
		if (kind === "denoise") return denoise(source, report);
		throw new Error("Unknown AI effect");
	}
};
window.dispatchEvent(new Event("pict-ai-ready"));
