// C:\Users\user\dev\my-study-compiler\src\hit\bindings.ts
import {
	ElementBinding,
	SceneElement,
	ScenePoint,
	SnapGuideLine,
} from "../scene/types";
import {
	getElementAABB,
	normalizeElementBounds,
	rotatePoint,
	unrotatePoint,
} from "./hitTest";
import { getContainerTextBox } from "../text/metrics";

export const BINDING_SNAP_DISTANCE = 24;
export const OBJECT_SNAP_THRESHOLD = 6;
export const GRID_SNAP_THRESHOLD_PX = 6;

export function isBindableShape(el: SceneElement): boolean {
	if (el.isDeleted) return false;
	return (
		el.type === "rectangle" ||
		el.type === "diamond" ||
		el.type === "ellipse" ||
		el.type === "image" ||
		el.type === "note" ||
		el.type === "text"
	);
}

/**
 * Вычисляет точку пересечения луча из внешнего курсора `externalPt` к центру фигуры `target`
 * с границей фигуры (с отступом `gap` пикселей).
 */
export function computeShapePerimeterPoint(
	target: SceneElement,
	externalPt: ScenePoint,
	gap = 4
): ScenePoint {
	const cx = target.x + target.width / 2;
	const cy = target.y + target.height / 2;
	const localExt = unrotatePoint(
		externalPt.x,
		externalPt.y,
		cx,
		cy,
		target.angle || 0
	);

	const dx = localExt.x - cx;
	const dy = localExt.y - cy;
	const len = Math.hypot(dx, dy);
	if (len < 0.001) {
		return { x: cx, y: target.y - gap };
	}

	const hw = target.width / 2 + gap;
	const hh = target.height / 2 + gap;

	let localHit: ScenePoint;

	if (target.type === "ellipse") {
		const angle = Math.atan2(dy, dx);
		localHit = {
			x: cx + hw * Math.cos(angle),
			y: cy + hh * Math.sin(angle),
		};
	} else if (target.type === "diamond") {
		const absDx = Math.abs(dx);
		const absDy = Math.abs(dy);
		const t = 1 / (absDx / Math.max(1, hw) + absDy / Math.max(1, hh));
		localHit = {
			x: cx + dx * t,
			y: cy + dy * t,
		};
	} else {
		// rectangle, note, image, text
		const scaleX = hw / Math.max(0.0001, Math.abs(dx));
		const scaleY = hh / Math.max(0.0001, Math.abs(dy));
		const t = Math.min(scaleX, scaleY);
		localHit = {
			x: cx + dx * t,
			y: cy + dy * t,
		};
	}

	return rotatePoint(localHit.x, localHit.y, cx, cy, target.angle || 0);
}

/**
 * Ищет ближайшую фигуру для привязки начала или конца стрелки/линии.
 */
export function findNearestBindingTarget(
	pt: ScenePoint,
	elements: readonly SceneElement[],
	excludeId?: string,
	maxDist = BINDING_SNAP_DISTANCE
): {
	element: SceneElement;
	binding: ElementBinding;
	snapPoint: ScenePoint;
} | null {
	let bestDist = maxDist;
	let bestResult: {
		element: SceneElement;
		binding: ElementBinding;
		snapPoint: ScenePoint;
	} | null = null;

	for (let i = elements.length - 1; i >= 0; i--) {
		const el = elements[i]!;
		if (!isBindableShape(el) || el.id === excludeId || el.containerId) continue;

		const cx = el.x + el.width / 2;
		const cy = el.y + el.height / 2;
		const perim = computeShapePerimeterPoint(el, pt, 4);
		const dPerim = Math.hypot(pt.x - perim.x, pt.y - perim.y);

		const local = unrotatePoint(pt.x, pt.y, cx, cy, el.angle || 0);
		const inside =
			local.x >= el.x &&
			local.x <= el.x + el.width &&
			local.y >= el.y &&
			local.y <= el.y + el.height;

		const effectiveDist = inside ? 0 : dPerim;
		if (effectiveDist < bestDist) {
			bestDist = effectiveDist;
			bestResult = {
				element: el,
				binding: {
					elementId: el.id,
					focus: 0,
					gap: 4,
				},
				snapPoint: perim,
			};
		}
	}

	return bestResult;
}

/**
 * Пересчитывает координаты концов всех привязанных стрелок и линий, а также центрирует привязанный текст внутри фигур.
 */
export function updateBoundElements(elements: SceneElement[]): void {
	const byId = new Map<string, SceneElement>();
	for (const el of elements) {
		if (!el.isDeleted) {
			byId.set(el.id, el);
		}
	}

	for (const el of elements) {
		if (el.isDeleted) continue;

		// Синхронизация текста, привязанного к фигуре-контейнеру
		if (el.type === "text" && el.containerId) {
			const container = byId.get(el.containerId);
			if (!container) {
				el.containerId = null;
				continue;
			}
			const box = getContainerTextBox(container);
			el.x = box.x;
			el.y = box.y;
			el.width = box.width;
			el.height = box.height;
			el.angle = container.angle;
			continue;
		}
		if (el.boundTextId && !byId.has(el.boundTextId)) {
			el.boundTextId = null;
		}

		// Синхронизация стрелок / линий с привязанными фигурами
		if (
			(el.type === "arrow" || el.type === "line") &&
			el.points &&
			el.points.length >= 2
		) {
			const pts = el.points;
			const firstWorld = { x: el.x + pts[0]!.x, y: el.y + pts[0]!.y };
			const lastIdx = pts.length - 1;
			const lastWorld = {
				x: el.x + pts[lastIdx]!.x,
				y: el.y + pts[lastIdx]!.y,
			};

			let newFirstWorld = firstWorld;
			let newLastWorld = lastWorld;

			const startTarget = el.startBinding
				? byId.get(el.startBinding.elementId)
				: undefined;
			const endTarget = el.endBinding
				? byId.get(el.endBinding.elementId)
				: undefined;
			if (el.startBinding && !startTarget) el.startBinding = null;
			if (el.endBinding && !endTarget) el.endBinding = null;

			if (startTarget) {
				const refPt =
					pts.length > 2
						? { x: el.x + pts[1]!.x, y: el.y + pts[1]!.y }
						: endTarget
							? {
									x: endTarget.x + endTarget.width / 2,
									y: endTarget.y + endTarget.height / 2,
							  }
							: lastWorld;
				newFirstWorld = computeShapePerimeterPoint(
					startTarget,
					refPt,
					el.startBinding?.gap ?? 4
				);
			}

			if (endTarget) {
				const refPt =
					pts.length > 2
						? {
								x: el.x + pts[lastIdx - 1]!.x,
								y: el.y + pts[lastIdx - 1]!.y,
						  }
						: startTarget
							? {
									x: startTarget.x + startTarget.width / 2,
									y: startTarget.y + startTarget.height / 2,
							  }
							: firstWorld;
				newLastWorld = computeShapePerimeterPoint(
					endTarget,
					refPt,
					el.endBinding?.gap ?? 4
				);
			}

			if (startTarget || endTarget) {
				// Пересчитываем локальные точки относительно новой первой точки
				const worldPoints = pts.map((p, i) => {
					if (i === 0) return newFirstWorld;
					if (i === lastIdx) return newLastWorld;
					return { x: el.x + p.x, y: el.y + p.y };
				});

				// Если стрелка ортогональная (elbowed) из 4 точек — выравниваем колено
				if (el.elbowed && worldPoints.length === 4) {
					const midX = (newFirstWorld.x + newLastWorld.x) / 2;
					worldPoints[1] = { x: midX, y: newFirstWorld.y };
					worldPoints[2] = { x: midX, y: newLastWorld.y };
				}

				// Каноничная геометрия: x/y — угол реального AABB, points — относительно него
				el.points = worldPoints.map((wp) => ({
					x: wp.x - el.x,
					y: wp.y - el.y,
				}));
				normalizeElementBounds(el);
			}
		}
	}
}

/**
 * Привязка к сетке и умным направляющим (центры и края соседних фигур) при перемещении.
 */
export function computeSnapOffset(
	movingAABB: { minX: number; minY: number; maxX: number; maxY: number; cx: number; cy: number },
	staticElements: readonly SceneElement[],
	movingIds: ReadonlySet<string>,
	opts: {
		snapToGrid: boolean;
		gridSize: number;
		snapToObjects: boolean;
		zoom: number;
	}
): { dx: number; dy: number; guides: SnapGuideLine[] } {
	const guides: SnapGuideLine[] = [];
	let dx = 0;
	let dy = 0;

	if (opts.snapToObjects) {
		const threshold = OBJECT_SNAP_THRESHOLD / Math.max(0.25, opts.zoom);
		let bestXDist = threshold;
		let bestYDist = threshold;
		let snapXGuide: SnapGuideLine | null = null;
		let snapYGuide: SnapGuideLine | null = null;

		const movingXs = [movingAABB.minX, movingAABB.cx, movingAABB.maxX];
		const movingYs = [movingAABB.minY, movingAABB.cy, movingAABB.maxY];

		for (const el of staticElements) {
			if (el.isDeleted || movingIds.has(el.id) || el.containerId) continue;
			const b = getElementAABB(el);
			const targetXs = [b.minX, b.cx, b.maxX];
			const targetYs = [b.minY, b.cy, b.maxY];

			for (const mx of movingXs) {
				for (const tx of targetXs) {
					const dist = Math.abs(mx - tx);
					if (dist < bestXDist) {
						bestXDist = dist;
						dx = tx - mx;
						snapXGuide = {
							type: "vertical",
							x1: tx,
							y1: Math.min(movingAABB.minY, b.minY) - 16,
							x2: tx,
							y2: Math.max(movingAABB.maxY, b.maxY) + 16,
						};
					}
				}
			}

			for (const my of movingYs) {
				for (const ty of targetYs) {
					const dist = Math.abs(my - ty);
					if (dist < bestYDist) {
						bestYDist = dist;
						dy = ty - my;
						snapYGuide = {
							type: "horizontal",
							x1: Math.min(movingAABB.minX, b.minX) - 16,
							y1: ty,
							x2: Math.max(movingAABB.maxX, b.maxX) + 16,
							y2: ty,
						};
					}
				}
			}
		}

		if (snapXGuide) guides.push(snapXGuide);
		if (snapYGuide) guides.push(snapYGuide);
	}

	if (opts.snapToGrid && opts.gridSize > 1) {
		// Сетка притягивает фигуру только вблизи линий, иначе перетаскивание «залипает» шагами по сетке
		const threshold = Math.min(
			GRID_SNAP_THRESHOLD_PX / Math.max(0.1, opts.zoom),
			opts.gridSize / 2
		);
		if (dx === 0) {
			const snappedX =
				Math.round(movingAABB.minX / opts.gridSize) * opts.gridSize;
			const offsetX = snappedX - movingAABB.minX;
			if (Math.abs(offsetX) <= threshold) dx = offsetX;
		}
		if (dy === 0) {
			const snappedY =
				Math.round(movingAABB.minY / opts.gridSize) * opts.gridSize;
			const offsetY = snappedY - movingAABB.minY;
			if (Math.abs(offsetY) <= threshold) dy = offsetY;
		}
	}

	return { dx, dy, guides };
}