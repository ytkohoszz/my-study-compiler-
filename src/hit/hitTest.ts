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

/**
 * Проверяет попадание точки `pt` (в координатах сцены) в элемент `el`.
 */
export function hitTestElement(
	el: SceneElement,
	pt: ScenePoint,
	zoom = 1
): boolean {
	if (el.isDeleted) return false;
	const threshold = Math.max(6 / Math.max(0.25, zoom), el.strokeWidth / 2 + 4);

	if (el.type === "arrow" || el.type === "line" || el.type === "freedraw") {
		const pts =
			el.type === "arrow" || el.type === "line"
				? getConnectorPolyline(el)
				: getElementWorldPoints(el);
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

	const cx = el.x + el.width / 2;
	const cy = el.y + el.height / 2;
	const local = unrotatePoint(pt.x, pt.y, cx, cy, el.angle || 0);

	if (el.type === "frame") {
		// В рамку попадаем по заголовку сверху или по её контуру
		const inHeader =
			local.x >= el.x &&
			local.x <= el.x + Math.min(220, el.width) &&
			local.y >= el.y - 26 &&
			local.y <= el.y;
		if (inHeader) return true;

		const nearLeft =
			Math.abs(local.x - el.x) <= threshold &&
			local.y >= el.y - threshold &&
			local.y <= el.y + el.height + threshold;
		const nearRight =
			Math.abs(local.x - (el.x + el.width)) <= threshold &&
			local.y >= el.y - threshold &&
			local.y <= el.y + el.height + threshold;
		const nearTop =
			Math.abs(local.y - el.y) <= threshold &&
			local.x >= el.x - threshold &&
			local.x <= el.x + el.width + threshold;
		const nearBottom =
			Math.abs(local.y - (el.y + el.height)) <= threshold &&
			local.x >= el.x - threshold &&
			local.x <= el.x + el.width + threshold;
		return nearLeft || nearRight || nearTop || nearBottom;
	}

	if (el.type === "ellipse") {
		const rx = Math.max(1, el.width / 2);
		const ry = Math.max(1, el.height / 2);
		const norm =
			(local.x - cx) ** 2 / (rx + threshold) ** 2 +
			(local.y - cy) ** 2 / (ry + threshold) ** 2;
		if (el.fillStyle === "none" || el.backgroundColor === "transparent") {
			const innerRx = Math.max(0, rx - threshold);
			const innerRy = Math.max(0, ry - threshold);
			const innerNorm =
				innerRx > 0 && innerRy > 0
					? (local.x - cx) ** 2 / innerRx ** 2 +
					  (local.y - cy) ** 2 / innerRy ** 2
					: 0;
			return norm <= 1 && innerNorm >= 1;
		}
		return norm <= 1;
	}

	if (el.type === "diamond") {
		const hw = Math.max(1, el.width / 2);
		const hh = Math.max(1, el.height / 2);
		const dist =
			Math.abs(local.x - cx) / (hw + threshold) +
			Math.abs(local.y - cy) / (hh + threshold);
		if (el.fillStyle === "none" || el.backgroundColor === "transparent") {
			const innerDist =
				Math.abs(local.x - cx) / Math.max(1, hw - threshold) +
				Math.abs(local.y - cy) / Math.max(1, hh - threshold);
			return dist <= 1 && innerDist >= 1;
		}
		return dist <= 1;
	}

	// rectangle, text, image, note
	return (
		local.x >= el.x - threshold &&
		local.x <= el.x + el.width + threshold &&
		local.y >= el.y - threshold &&
		local.y <= el.y + el.height + threshold
	);
}

/**
 * Находит самый верхний по слою (zIndex) видимый элемент под курсором.
 * Привязанные текстовые элементы (`containerId !== null`) пропускаются в пользу их родительской фигуры.
 */
export function getElementAtPoint(
	elements: readonly SceneElement[],
	pt: ScenePoint,
	zoom = 1
): SceneElement | null {
	for (let i = elements.length - 1; i >= 0; i--) {
		const el = elements[i]!;
		if (el.isDeleted || el.containerId) continue;
		if (hitTestElement(el, pt, zoom)) {
			return el;
		}
	}
	return null;
}

/**
 * Возвращает список интерактивных ручек трансформации / узлов линии для выбранных элементов.
 */
export function getTransformHandles(
	selectedElements: readonly SceneElement[],
	zoom = 1
): HandleDescriptor[] {
	if (selectedElements.length === 0) return [];

	if (selectedElements.length === 1) {
		const el = selectedElements[0]!;
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

		const cx = el.x + el.width / 2;
		const cy = el.y + el.height / 2;
		const angle = el.angle || 0;
		const rotOffset = ROTATE_HANDLE_OFFSET_PX / Math.max(0.25, zoom);

		const rawHandles: Array<{ kind: HandleKind; x: number; y: number }> = [
			{ kind: "nw", x: el.x, y: el.y },
			{ kind: "n", x: cx, y: el.y },
			{ kind: "ne", x: el.x + el.width, y: el.y },
			{ kind: "e", x: el.x + el.width, y: cy },
			{ kind: "se", x: el.x + el.width, y: el.y + el.height },
			{ kind: "s", x: cx, y: el.y + el.height },
			{ kind: "sw", x: el.x, y: el.y + el.height },
			{ kind: "w", x: el.x, y: cy },
			{ kind: "rotate", x: cx, y: el.y - rotOffset },
		];

		return rawHandles.map((h) => {
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
	const box = getSelectionAABB(selectedElements);
	if (!box) return [];
	const rotOffset = ROTATE_HANDLE_OFFSET_PX / Math.max(0.25, zoom);

	return [
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
}

export function hitTestHandles(
	handles: readonly HandleDescriptor[],
	pt: ScenePoint,
	zoom = 1
): HandleDescriptor | null {
	const radius = (HANDLE_HIT_RADIUS_PX + 2) / Math.max(0.25, zoom);
	for (let i = handles.length - 1; i >= 0; i--) {
		const h = handles[i]!;
		if (Math.hypot(pt.x - h.x, pt.y - h.y) <= radius) {
			return h;
		}
	}
	return null;
}