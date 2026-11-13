// C:\Users\user\dev\my-study-compiler\src\render\rough.ts
import { FillStyle, ScenePoint } from "../scene/types";

/**
 * Детерминированный ГПСЧ (Mulberry32) по seed элемента,
 * чтобы небрежные штрихи (roughness > 0) не дрожали при перерисовке и зуме.
 */
export class SeededRandom {
	private state: number;

	constructor(seed: number) {
		this.state = seed || 1;
	}

	next(): number {
		let t = (this.state += 0x6d2b79f5);
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}

	offset(maxAmp: number): number {
		return (this.next() - 0.5) * 2 * maxAmp;
	}
}

export function drawRoughLine(
	ctx: CanvasRenderingContext2D,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	roughness: number,
	rng: SeededRandom
): void {
	if (roughness <= 0.05) {
		ctx.moveTo(x1, y1);
		ctx.lineTo(x2, y2);
		return;
	}

	const len = Math.hypot(x2 - x1, y2 - y1);
	const amp = Math.min(roughness * 1.4, Math.max(0.6, len * 0.02));
	const midX = (x1 + x2) / 2;
	const midY = (y1 + y2) / 2;

	// Проход 1
	ctx.moveTo(x1 + rng.offset(amp * 0.5), y1 + rng.offset(amp * 0.5));
	ctx.quadraticCurveTo(
		midX + rng.offset(amp),
		midY + rng.offset(amp),
		x2 + rng.offset(amp * 0.5),
		y2 + rng.offset(amp * 0.5)
	);

	// Проход 2 (двойной контур в стиле Excalidraw)
	ctx.moveTo(x1 + rng.offset(amp * 0.4), y1 + rng.offset(amp * 0.4));
	ctx.quadraticCurveTo(
		midX + rng.offset(amp * 0.8),
		midY + rng.offset(amp * 0.8),
		x2 + rng.offset(amp * 0.4),
		y2 + rng.offset(amp * 0.4)
	);
}

const patternPathCache = new Map<string, Path2D>();
const MAX_PATTERN_CACHE_ENTRIES = 400;

function getCachedHatchPath(
	w: number,
	h: number,
	fillStyle: FillStyle,
	strokeWidth: number,
	roughness: number,
	seed: number
): Path2D | null {
	if (typeof Path2D === "undefined") return null;
	const rw = Math.round(w);
	const rh = Math.round(h);
	const key = `${rw}|${rh}|${fillStyle}|${strokeWidth}|${roughness}|${seed}`;
	const existing = patternPathCache.get(key);
	if (existing) return existing;

	const path = new Path2D();
	const rng = new SeededRandom(seed + 101);
	const step = Math.max(6, 9 + strokeWidth * 1.2);
	const diag = Math.hypot(rw, rh);

	const appendRotatedLines = (angleRad: number) => {
		const cos = Math.cos(angleRad);
		const sin = Math.sin(angleRad);
		const tx = (px: number, py: number) => px * cos - py * sin;
		const ty = (px: number, py: number) => px * sin + py * cos;

		for (let pos = -diag; pos <= diag; pos += step) {
			if (roughness > 0) {
				const amp = Math.min(roughness * 0.84, Math.max(0.4, (diag * 2) * 0.015));
				const x1 = -diag + rng.offset(amp * 0.5);
				const y1 = pos + rng.offset(amp * 0.5);
				const mx = rng.offset(amp);
				const my = pos + rng.offset(amp);
				const x2 = diag + rng.offset(amp * 0.5);
				const y2 = pos + rng.offset(amp * 0.5);
				path.moveTo(tx(x1, y1), ty(x1, y1));
				path.quadraticCurveTo(tx(mx, my), ty(mx, my), tx(x2, y2), ty(x2, y2));
			} else {
				path.moveTo(tx(-diag, pos), ty(-diag, pos));
				path.lineTo(tx(diag, pos), ty(diag, pos));
			}
		}
	};

	appendRotatedLines(-Math.PI / 4);
	if (fillStyle === "cross-hatch") {
		appendRotatedLines(Math.PI / 4);
	}

	if (patternPathCache.size >= MAX_PATTERN_CACHE_ENTRIES) {
		patternPathCache.clear();
	}
	patternPathCache.set(key, path);
	return path;
}

/**
 * Заполняет текущую область клиппинга штриховкой (`hachure` или `cross-hatch`).
 */
export function renderPatternFill(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	fillStyle: FillStyle,
	color: string,
	strokeWidth: number,
	roughness: number,
	seed: number
): void {
	if (fillStyle === "none" || color === "transparent") return;

	if (fillStyle === "solid") {
		ctx.fillStyle = color;
		ctx.fill();
		return;
	}

	ctx.save();
	ctx.clip();
	ctx.strokeStyle = color;
	ctx.lineWidth = Math.max(1, strokeWidth * 0.65);
	ctx.setLineDash([]);

	const cached = getCachedHatchPath(w, h, fillStyle, strokeWidth, roughness, seed);
	if (cached) {
		ctx.translate(x + w / 2, y + h / 2);
		ctx.stroke(cached);
		ctx.restore();
		return;
	}

	const rng = new SeededRandom(seed + 101);
	const step = Math.max(6, 9 + strokeWidth * 1.2);
	const diag = Math.hypot(w, h);
	const cx = x + w / 2;
	const cy = y + h / 2;

	const drawSet = (angleRad: number) => {
		ctx.save();
		ctx.translate(cx, cy);
		ctx.rotate(angleRad);
		ctx.beginPath();
		for (let pos = -diag; pos <= diag; pos += step) {
			if (roughness > 0) {
				drawRoughLine(
					ctx,
					-diag,
					pos,
					diag,
					pos,
					roughness * 0.6,
					rng
				);
			} else {
				ctx.moveTo(-diag, pos);
				ctx.lineTo(diag, pos);
			}
		}
		ctx.stroke();
		ctx.restore();
	};

	drawSet(-Math.PI / 4);
	if (fillStyle === "cross-hatch") {
		drawSet(Math.PI / 4);
	}

	ctx.restore();
}

const freedrawPathCache = new WeakMap<
	readonly ScenePoint[],
	{ count: number; baseWidth: number; path: Path2D }
>();

function buildFreedrawLocalPath(
	points: readonly ScenePoint[],
	baseWidth: number
): Path2D {
	const path = new Path2D();
	const centers = points.map((point) => ({
		x: point.x,
		y: point.y,
		radius:
			Math.max(1.5, baseWidth / 2) *
			(0.3 + Math.max(0, Math.min(1, point.pressure ?? 0.5)) * 0.7),
	}));

	if (centers.length === 1) {
		const point = centers[0]!;
		path.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
		return path;
	}

	const sides = centers.map((point, index) => {
		const previous = centers[Math.max(0, index - 1)]!;
		const next = centers[Math.min(centers.length - 1, index + 1)]!;
		const dx = next.x - previous.x;
		const dy = next.y - previous.y;
		const length = Math.max(0.001, Math.hypot(dx, dy));
		const nx = -dy / length;
		const ny = dx / length;
		return {
			left: {
				x: point.x + nx * point.radius,
				y: point.y + ny * point.radius,
			},
			right: {
				x: point.x - nx * point.radius,
				y: point.y - ny * point.radius,
			},
		};
	});

	path.moveTo(sides[0]!.left.x, sides[0]!.left.y);
	for (let index = 1; index < sides.length - 1; index++) {
		const current = sides[index]!.left;
		const next = sides[index + 1]!.left;
		path.quadraticCurveTo(
			current.x,
			current.y,
			(current.x + next.x) / 2,
			(current.y + next.y) / 2
		);
	}
	path.lineTo(sides[sides.length - 1]!.left.x, sides[sides.length - 1]!.left.y);
	for (let index = sides.length - 1; index > 0; index--) {
		const current = sides[index]!.right;
		const previous = sides[index - 1]!.right;
		path.quadraticCurveTo(
			current.x,
			current.y,
			(current.x + previous.x) / 2,
			(current.y + previous.y) / 2
		);
	}
	path.lineTo(sides[0]!.right.x, sides[0]!.right.y);
	path.closePath();

	for (const point of [centers[0]!, centers[centers.length - 1]!]) {
		path.moveTo(point.x + point.radius, point.y);
		path.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
	}
	return path;
}

/**
 * Строит и отрисовывает сглаженную кривую свободного рисования (freedraw)
 * с переменной толщиной от скорости/нажима (с кэшированием Path2D).
 */
export function renderFreedrawStroke(
	ctx: CanvasRenderingContext2D,
	originX: number,
	originY: number,
	points: readonly ScenePoint[],
	strokeColor: string,
	baseWidth: number
): void {
	if (points.length === 0) return;

	ctx.save();
	ctx.fillStyle = strokeColor;

	if (typeof Path2D !== "undefined") {
		let entry = freedrawPathCache.get(points);
		if (!entry || entry.count !== points.length || entry.baseWidth !== baseWidth) {
			entry = {
				count: points.length,
				baseWidth,
				path: buildFreedrawLocalPath(points, baseWidth),
			};
			freedrawPathCache.set(points, entry);
		}
		ctx.translate(originX, originY);
		ctx.fill(entry.path);
		ctx.restore();
		return;
	}

	const centers = points.map((point) => ({
		x: originX + point.x,
		y: originY + point.y,
		radius:
			Math.max(1.5, baseWidth / 2) *
			(0.3 + Math.max(0, Math.min(1, point.pressure ?? 0.5)) * 0.7),
	}));

	if (centers.length === 1) {
		const point = centers[0]!;
		ctx.beginPath();
		ctx.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();
		return;
	}

	const sides = centers.map((point, index) => {
		const previous = centers[Math.max(0, index - 1)]!;
		const next = centers[Math.min(centers.length - 1, index + 1)]!;
		const dx = next.x - previous.x;
		const dy = next.y - previous.y;
		const length = Math.max(0.001, Math.hypot(dx, dy));
		const nx = -dy / length;
		const ny = dx / length;
		return {
			left: {
				x: point.x + nx * point.radius,
				y: point.y + ny * point.radius,
			},
			right: {
				x: point.x - nx * point.radius,
				y: point.y - ny * point.radius,
			},
		};
	});

	ctx.beginPath();
	ctx.moveTo(sides[0]!.left.x, sides[0]!.left.y);
	for (let index = 1; index < sides.length - 1; index++) {
		const current = sides[index]!.left;
		const next = sides[index + 1]!.left;
		ctx.quadraticCurveTo(
			current.x,
			current.y,
			(current.x + next.x) / 2,
			(current.y + next.y) / 2
		);
	}
	ctx.lineTo(sides[sides.length - 1]!.left.x, sides[sides.length - 1]!.left.y);
	for (let index = sides.length - 1; index > 0; index--) {
		const current = sides[index]!.right;
		const previous = sides[index - 1]!.right;
		ctx.quadraticCurveTo(
			current.x,
			current.y,
			(current.x + previous.x) / 2,
			(current.y + previous.y) / 2
		);
	}
	ctx.lineTo(sides[0]!.right.x, sides[0]!.right.y);
	ctx.closePath();
	ctx.fill();
	for (const point of [centers[0]!, centers[centers.length - 1]!]) {
		ctx.beginPath();
		ctx.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.restore();
}