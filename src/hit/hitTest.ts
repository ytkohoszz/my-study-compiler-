// C:\Users\user\dev\my-study-compiler\src\hit\hitTest.ts
import {
	AABB,
	HandleDescriptor,
	HandleKind,
	SceneElement,
	ScenePoint,
} from "../scene/types";

export const ROTATE_HANDLE_OFFSET_PX = 26;
export const HANDLE_HIT_RADIUS_PX = 8;

export function rotatePoint(
	px: number,
	py: number,
	cx: number,
	cy: number,
	angleRad: number
): ScenePoint {
	if (!angleRad) return { x: px, y: py };
	const cos = Math.cos(angleRad);
	const sin = Math.sin(angleRad);
	const dx = px - cx;
	const dy = py - cy;
	return {
		x: cx + dx * cos - dy * sin,
		y: cy + dx * sin + dy * cos,
	};
}

export function unrotatePoint(
	px: number,
	py: number,
	cx: number,
	cy: number,
	angleRad: number
): ScenePoint {
	return rotatePoint(px, py, cx, cy, -angleRad);
}

export function distanceToSegment(
	px: number,
	py: number,
	x1: number,
	y1: number,
	x2: number,
	y2: number
): number {
	const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
	if (l2 === 0) return Math.hypot(px - x1, py - y1);
	let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
	t = Math.max(0, Math.min(1, t));
	const projX = x1 + t * (x2 - x1);
	const projY = y1 + t * (y2 - y1);
	return Math.hypot(px - projX, py - projY);
}

export function getElementWorldPoints(el: SceneElement): ScenePoint[] {
	if (!el.points || el.points.length === 0) {
		return [
			{ x: el.x, y: el.y },
			{ x: el.x + el.width, y: el.y + el.height },
		];
	}
	return el.points.map((p) => ({
		x: el.x + p.x,
		y: el.y + p.y,
		pressure: p.pressure,
	}));
}

export function isPathElement(el: SceneElement): boolean {
	return el.type === "arrow" || el.type === "line" || el.type === "freedraw";
}

/**
 * Приводит линию, стрелку или штрих к каноничной геометрии: `x`/`y` — левый верхний угол
 * реального AABB по всем мировым точкам, `width`/`height` — его размеры,
 * а `points` хранятся относительно этого угла (без отрицательных координат).
 */
export function normalizeElementBounds(el: SceneElement): void {
	if (!el.points || el.points.length === 0) return;
	const worldPoints = getElementWorldPoints(el);
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of worldPoints) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;
	el.x = minX;
	el.y = minY;
	el.width = Math.max(1, maxX - minX);
	el.height = Math.max(1, maxY - minY);
	el.points = worldPoints.map((p) => ({
		x: p.x - minX,
		y: p.y - minY,
		pressure: p.pressure,
	}));
}

function sampleQuadratic(
	start: ScenePoint,
	control: ScenePoint,
	end: ScenePoint,
	steps: number
): ScenePoint[] {
	const result: ScenePoint[] = [];
	for (let index = 1; index <= steps; index++) {
		const t = index / steps;
		const inverse = 1 - t;
		result.push({
			x:
				inverse * inverse * start.x +
				2 * inverse * t * control.x +
				t * t * end.x,
			y:
				inverse * inverse * start.y +
				2 * inverse * t * control.y +
				t * t * end.y,
		});
	}
	return result;
}

function sampleCubic(
	start: ScenePoint,
	control1: ScenePoint,
	control2: ScenePoint,
	end: ScenePoint,
	steps: number
): ScenePoint[] {
	const result: ScenePoint[] = [];
	for (let index = 1; index <= steps; index++) {
		const t = index / steps;
		const inverse = 1 - t;
		result.push({
			x:
				inverse ** 3 * start.x +
				3 * inverse ** 2 * t * control1.x +
				3 * inverse * t ** 2 * control2.x +
				t ** 3 * end.x,
			y:
				inverse ** 3 * start.y +
				3 * inverse ** 2 * t * control1.y +
				3 * inverse * t ** 2 * control2.y +
				t ** 3 * end.y,
		});
	}
	return result;
}

export function getConnectorPolyline(el: SceneElement): ScenePoint[] {
	const points = getElementWorldPoints(el);
	if (points.length < 2) return points;

	if (el.curved) {
		if (points.length === 2) {
			const start = points[0]!;
			const end = points[1]!;
			const dx = end.x - start.x;
			const dy = end.y - start.y;
			const length = Math.max(1, Math.hypot(dx, dy));
			const offset = Math.min(120, length * 0.2);
			const nx = -dy / length;
			const ny = dx / length;
			return [
				start,
				...sampleCubic(
					start,
					{
						x: start.x + dx / 3 + nx * offset,
						y: start.y + dy / 3 + ny * offset,
					},
					{
						x: start.x + (dx * 2) / 3 + nx * offset,
						y: start.y + (dy * 2) / 3 + ny * offset,
					},
					end,
					24
				),
			];
		}

		const sampled: ScenePoint[] = [points[0]!];
		let cursor = points[0]!;
		for (let index = 1; index < points.length - 1; index++) {
			const control = points[index]!;
			const next = points[index + 1]!;
			const end = { x: (control.x + next.x) / 2, y: (control.y + next.y) / 2 };
			sampled.push(...sampleQuadratic(cursor, control, end, 12));
			cursor = end;
		}
		const finalPoint = points[points.length - 1]!;
		sampled.push(
			...sampleQuadratic(cursor, points[points.length - 2]!, finalPoint, 12)
		);
		return sampled;
	}

	if (el.elbowed && points.length === 2) {
		const start = points[0]!;
		const end = points[1]!;
		const midX = (start.x + end.x) / 2;
		return [
			start,
			{ x: midX, y: start.y },
			{ x: midX, y: end.y },
			end,
		];
	}
	return points;
}

/**
 * Вычисляет мировой выровненный по осям ограничивающий прямоугольник (AABB) элемента с учётом поворота и точек.
 */
export function getElementAABB(el: SceneElement): AABB {
	if (
		(el.type === "arrow" || el.type === "line" || el.type === "freedraw") &&
		el.points &&
		el.points.length > 0
	) {
		const points =
			el.type === "arrow" || el.type === "line"
				? getConnectorPolyline(el)
				: getElementWorldPoints(el);
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const pt of points) {
			if (pt.x < minX) minX = pt.x;
			if (pt.y < minY) minY = pt.y;
			if (pt.x > maxX) maxX = pt.x;
			if (pt.y > maxY) maxY = pt.y;
		}
		if (!Number.isFinite(minX)) {
			minX = el.x;
			minY = el.y;
			maxX = el.x + el.width;
			maxY = el.y + el.height;
		}
		const w = Math.max(1, maxX - minX);
		const h = Math.max(1, maxY - minY);
		return {
			minX,
			minY,
			maxX,
			maxY,
			width: w,
			height: h,
			cx: minX + w / 2,
			cy: minY + h / 2,
		};
	}

	const cx = el.x + el.width / 2;
	const cy = el.y + el.height / 2;

	if (!el.angle) {
		return {
			minX: el.x,
			minY: el.y,
			maxX: el.x + el.width,
			maxY: el.y + el.height,
			width: el.width,
			height: el.height,
			cx,
			cy,
		};
	}

	const corners = [
		rotatePoint(el.x, el.y, cx, cy, el.angle),
		rotatePoint(el.x + el.width, el.y, cx, cy, el.angle),
		rotatePoint(el.x + el.width, el.y + el.height, cx, cy, el.angle),
		rotatePoint(el.x, el.y + el.height, cx, cy, el.angle),
	];

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const c of corners) {
		if (c.x < minX) minX = c.x;
		if (c.y < minY) minY = c.y;
		if (c.x > maxX) maxX = c.x;
		if (c.y > maxY) maxY = c.y;
	}

	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
		cx,
		cy,
	};
}

export function getSelectionAABB(elements: readonly SceneElement[]): AABB | null {
	if (elements.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const el of elements) {
		const b = getElementAABB(el);
		if (b.minX < minX) minX = b.minX;
		if (b.minY < minY) minY = b.minY;
		if (b.maxX > maxX) maxX = b.maxX;
		if (b.maxY > maxY) maxY = b.maxY;
	}

	if (!Number.isFinite(minX)) return null;
	const width = Math.max(1, maxX - minX);
	const height = Math.max(1, maxY - minY);
	return {
		minX,
		minY,
		maxX,
		maxY,
		width,
		height,
		cx: minX + width / 2,
		cy: minY + height / 2,
	};
}

export function aabbIntersects(a: AABB, b: AABB): boolean {
	return !(
		a.minX > b.maxX ||
		a.maxX < b.minX ||
		a.minY > b.maxY ||
		a.maxY < b.minY
	);
}

const HIT_SLOP_PX = 6;

/** Запас попадания в мировых единицах: половина толщины штриха + 6 экранных px независимо от масштаба. */
function getHitThreshold(el: SceneElement, zoom: number): number {
	return el.strokeWidth / 2 + HIT_SLOP_PX / Math.max(0.1, zoom);
}

export function isTransparentColor(color: string | null | undefined): boolean {
	if (!color) return true;
	const value = color.trim().toLowerCase();
	if (value === "" || value === "transparent" || value === "none") return true;
	if (/^#[0-9a-f]{8}$/.test(value)) return value.endsWith("00");
	if (/^#[0-9a-f]{4}$/.test(value)) return value.endsWith("0");
	const functional = /^rgba?\(([^)]*)\)$/.exec(value);
	if (functional?.[1]) {
		const parts = functional[1].split(/[\s,/]+/).filter(Boolean);
		return parts.length >= 4 && Number.parseFloat(parts[3]!) === 0;
	}
	return false;
}

export function hasVisibleFill(el: SceneElement): boolean {
	return el.fillStyle !== "none" && !isTransparentColor(el.backgroundColor);
}

/** Фигуры без видимой заливки выделяются по контуру; их пустое нутро проверяется отдельным вторым проходом. */
function isOutlineOnlyShape(el: SceneElement): boolean {
	return (
		(el.type === "rectangle" ||
			el.type === "ellipse" ||
			el.type === "diamond") &&
		!hasVisibleFill(el)
	);
}

/**
 * Лежит ли точка (в системе координат элемента без поворота) внутри фигуры,
 * увеличенной (`margin > 0`) или уменьшенной (`margin < 0`) на `margin` со всех сторон.
 */
function isInsideShape(
	el: SceneElement,
	local: ScenePoint,
	margin: number
): boolean {
	const halfW = el.width / 2 + margin;
	const halfH = el.height / 2 + margin;
	if (halfW <= 0 || halfH <= 0) return false;
	const dx = local.x - (el.x + el.width / 2);
	const dy = local.y - (el.y + el.height / 2);
	if (el.type === "ellipse") {
		return (dx * dx) / (halfW * halfW) + (dy * dy) / (halfH * halfH) <= 1;
	}
	if (el.type === "diamond") {
		return Math.abs(dx) / halfW + Math.abs(dy) / halfH <= 1;
	}
	return Math.abs(dx) <= halfW && Math.abs(dy) <= halfH;
}

function hitTestPath(
	el: SceneElement,
	pt: ScenePoint,
	threshold: number
): boolean {
	const pts =
		el.type === "freedraw" ? getElementWorldPoints(el) : getConnectorPolyline(el);
	if (pts.length === 0) return false;
	if (pts.length === 1) {
		return Math.hypot(pt.x - pts[0]!.x, pt.y - pts[0]!.y) <= threshold;
	}
	for (let i = 0; i < pts.length - 1; i++) {
		const p1 = pts[i]!;
		const p2 = pts[i + 1]!;
		if (distanceToSegment(pt.x, pt.y, p1.x, p1.y, p2.x, p2.y) <= threshold) {
			return true;
		}
	}
	return false;
}

function hitTestFrame(
	el: SceneElement,
	local: ScenePoint,
	threshold: number
): boolean {
	// В рамку попадаем по заголовку сверху или по её контуру
	const inHeader =
		local.x >= el.x &&
		local.x <= el.x + Math.min(220, el.width) &&
		local.y >= el.y - 26 &&
		local.y <= el.y;
	if (inHeader) return true;
	return (
		isInsideShape(el, local, threshold) && !isInsideShape(el, local, -threshold)
	);
}

function toElementLocal(el: SceneElement, pt: ScenePoint): ScenePoint {
	return unrotatePoint(
		pt.x,
		pt.y,
		el.x + el.width / 2,
		el.y + el.height / 2,
		el.angle || 0
	);
}

/**
 * Первый проход: линии и штрихи, контуры фигур без заливки, закрашенные фигуры,
 * текст, заметки и изображения.
 */
function hitTestSolid(el: SceneElement, pt: ScenePoint, zoom: number): boolean {
	if (el.isDeleted) return false;
	const threshold = getHitThreshold(el, zoom);
	if (isPathElement(el)) return hitTestPath(el, pt, threshold);

	const local = toElementLocal(el, pt);
	if (el.type === "frame") return hitTestFrame(el, local, threshold);
	if (isOutlineOnlyShape(el)) {
		return (
			isInsideShape(el, local, threshold) &&
			!isInsideShape(el, local, -threshold)
		);
	}
	// rectangle, ellipse, diamond с заливкой, text, image, note
	return isInsideShape(el, local, threshold);
}

/** Второй проход: пустое нутро фигур без заливки. */
function hitTestEmptyInterior(
	el: SceneElement,
	pt: ScenePoint,
	zoom: number
): boolean {
	if (el.isDeleted || !isOutlineOnlyShape(el)) return false;
	return isInsideShape(el, toElementLocal(el, pt), getHitThreshold(el, zoom));
}

/**
 * Проверяет попадание точки `pt` (в координатах сцены) в элемент `el`:
 * по линии, тексту, заливке или внутри контура.
 */
export function hitTestElement(
	el: SceneElement,
	pt: ScenePoint,
	zoom = 1
): boolean {
	return hitTestSolid(el, pt, zoom) || hitTestEmptyInterior(el, pt, zoom);
}

/**
 * Находит самый верхний по слою (zIndex) видимый элемент под курсором.
 * Сначала проверяются линии, текст и закрашенные области, и только потом нутро фигур без заливки
 * (`includeEmptyInterior`), чтобы прозрачный контейнер не перехватывал клики по его содержимому.
 * Привязанные текстовые элементы (`containerId !== null`) пропускаются в пользу их родительской фигуры.
 */
export function getElementAtPoint(
	elements: readonly SceneElement[],
	pt: ScenePoint,
	zoom = 1,
	includeEmptyInterior = true
): SceneElement | null {
	for (let i = elements.length - 1; i >= 0; i--) {
		const el = elements[i]!;
		if (el.isDeleted || el.containerId) continue;
		if (hitTestSolid(el, pt, zoom)) return el;
	}
	if (!includeEmptyInterior) return null;
	for (let i = elements.length - 1; i >= 0; i--) {
		const el = elements[i]!;
		if (el.isDeleted || el.containerId) continue;
		if (hitTestEmptyInterior(el, pt, zoom)) return el;
	}
	return null;
}

/**
 * Рамка элемента, по которой строятся контур выделения и ручки.
 * Для штриха берётся реальный AABB точек: `x`/`y` рисованной линии могут не совпадать с её краем.
 */
export function getElementFrameBox(el: SceneElement): {
	x: number;
	y: number;
	width: number;
	height: number;
} {
	if (el.type === "freedraw" && el.points && el.points.length > 0) {
		const box = getElementAABB(el);
		return { x: box.minX, y: box.minY, width: box.width, height: box.height };
	}
	return { x: el.x, y: el.y, width: el.width, height: el.height };
}

/**
 * Привязанный текст выделяется вместе с фигурой-контейнером,
 * но контур и ручки строятся только по самой фигуре.
 */
export function getSelectionFrameElements(
	selected: readonly SceneElement[]
): SceneElement[] {
	const ids = new Set(selected.map((el) => el.id));
	return selected.filter((el) => !(el.containerId && ids.has(el.containerId)));
}

/**
 * Возвращает список интерактивных ручек трансформации / узлов линии для выбранных элементов.
 */
export function getTransformHandles(
	selectedElements: readonly SceneElement[],
	zoom = 1
): HandleDescriptor[] {
	const targets = getSelectionFrameElements(selectedElements);
	if (targets.length === 0) return [];

	if (targets.length === 1) {
		const el = targets[0]!;
		if (el.locked) return [];

		if (el.type === "arrow" || el.type === "line") {
			const pts = getElementWorldPoints(el);
			const handles: HandleDescriptor[] = [];
			for (let i = 0; i < pts.length; i++) {
				handles.push({
					kind: "point",
					x: pts[i]!.x,
					y: pts[i]!.y,
					pointIndex: i,
					elementId: el.id,
				});
				if (i < pts.length - 1) {
					const next = pts[i + 1]!;
					handles.push({
						kind: "midpoint",
						x: (pts[i]!.x + next.x) / 2,
						y: (pts[i]!.y + next.y) / 2,
						pointIndex: i + 1,
						elementId: el.id,
					});
				}
			}
			return handles;
		}

		const box = getElementFrameBox(el);
		const cx = box.x + box.width / 2;
		const cy = box.y + box.height / 2;
		const angle = el.angle || 0;
		const rotOffset = ROTATE_HANDLE_OFFSET_PX / Math.max(0.1, zoom);
		const hidden = getHiddenSideHandles(box.width, box.height, zoom);

		const rawHandles: Array<{ kind: HandleKind; x: number; y: number }> = [
			{ kind: "nw", x: box.x, y: box.y },
			{ kind: "n", x: cx, y: box.y },
			{ kind: "ne", x: box.x + box.width, y: box.y },
			{ kind: "e", x: box.x + box.width, y: cy },
			{ kind: "se", x: box.x + box.width, y: box.y + box.height },
			{ kind: "s", x: cx, y: box.y + box.height },
			{ kind: "sw", x: box.x, y: box.y + box.height },
			{ kind: "w", x: box.x, y: cy },
			{ kind: "rotate", x: cx, y: box.y - rotOffset },
		];

		return rawHandles
			.filter((h) => !hidden.has(h.kind))
			.map((h) => {
				const r = rotatePoint(h.x, h.y, cx, cy, angle);
				return {
					kind: h.kind,
					x: r.x,
					y: r.y,
					elementId: el.id,
				};
			});
	}

	// Множественное выделение — общий AABB
	const box = getSelectionAABB(targets);
	if (!box) return [];
	const rotOffset = ROTATE_HANDLE_OFFSET_PX / Math.max(0.1, zoom);
	const hidden = getHiddenSideHandles(box.width, box.height, zoom);

	const groupHandles: HandleDescriptor[] = [
		{ kind: "nw", x: box.minX, y: box.minY },
		{ kind: "n", x: box.cx, y: box.minY },
		{ kind: "ne", x: box.maxX, y: box.minY },
		{ kind: "e", x: box.maxX, y: box.cy },
		{ kind: "se", x: box.maxX, y: box.maxY },
		{ kind: "s", x: box.cx, y: box.maxY },
		{ kind: "sw", x: box.minX, y: box.maxY },
		{ kind: "w", x: box.minX, y: box.cy },
		{ kind: "rotate", x: box.cx, y: box.minY - rotOffset },
	];
	return groupHandles.filter((h) => !hidden.has(h.kind));
}

/** Минимальная длина стороны на экране, при которой у неё ещё показывается ручка середины. */
const MIN_SIDE_HANDLE_SPAN_PX = 16;

/** Ручки середин сторон скрываются у совсем маленьких элементов, чтобы не сливаться с угловыми. */
function getHiddenSideHandles(
	width: number,
	height: number,
	zoom: number
): ReadonlySet<HandleKind> {
	const scale = Math.max(0.1, zoom);
	const hidden = new Set<HandleKind>();
	if (width * scale < MIN_SIDE_HANDLE_SPAN_PX) {
		hidden.add("n");
		hidden.add("s");
	}
	if (height * scale < MIN_SIDE_HANDLE_SPAN_PX) {
		hidden.add("e");
		hidden.add("w");
	}
	return hidden;
}

/** При наложении ручек выигрывают вращение и узлы линии, затем углы, затем середины сторон. */
const HANDLE_PRIORITY: Partial<Record<HandleKind, number>> = {
	rotate: 0,
	point: 0,
	nw: 1,
	ne: 1,
	se: 1,
	sw: 1,
	midpoint: 2,
	n: 2,
	e: 2,
	s: 2,
	w: 2,
};

export function hitTestHandles(
	handles: readonly HandleDescriptor[],
	pt: ScenePoint,
	zoom = 1
): HandleDescriptor | null {
	const radius = (HANDLE_HIT_RADIUS_PX + 2) / Math.max(0.1, zoom);
	let best: HandleDescriptor | null = null;
	let bestPriority = Infinity;
	let bestDistance = Infinity;
	for (const handle of handles) {
		const distance = Math.hypot(pt.x - handle.x, pt.y - handle.y);
		if (distance > radius) continue;
		const priority = HANDLE_PRIORITY[handle.kind] ?? 3;
		if (
			priority < bestPriority ||
			(priority === bestPriority && distance < bestDistance)
		) {
			best = handle;
			bestPriority = priority;
			bestDistance = distance;
		}
	}
	return best;
}