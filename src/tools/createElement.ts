import {
	CanvasToolId,
	ElementStyleDefaults,
	SceneElement,
	SceneElementType,
	ScenePoint,
	generateElementId,
	hashStringSeed,
} from "../scene/types";
import { constrainTo45Degrees } from "../input/pointer";
import { normalizeElementBounds } from "../hit/hitTest";
import { TEXT_LINE_HEIGHT } from "../text/metrics";

const DRAW_TO_ELEMENT: Partial<Record<CanvasToolId, SceneElementType>> = {
	rectangle: "rectangle",
	diamond: "diamond",
	ellipse: "ellipse",
	arrow: "arrow",
	line: "line",
	freedraw: "freedraw",
	text: "text",
	note: "note",
	frame: "frame",
};

export function getElementTypeForTool(
	tool: CanvasToolId
): SceneElementType | null {
	return DRAW_TO_ELEMENT[tool] ?? null;
}

export function createSceneElement(
	type: SceneElementType,
	point: ScenePoint,
	style: ElementStyleDefaults,
	zIndex: number
): SceneElement {
	const id = generateElementId(type);
	const isPath = type === "arrow" || type === "line" || type === "freedraw";
	const isText = type === "text";
	const isFrame = type === "frame";
	const element: SceneElement = {
		id,
		type,
		x: point.x,
		y: point.y,
		width: 1,
		height: isText ? style.fontSize * TEXT_LINE_HEIGHT : 1,
		angle: 0,
		strokeColor: style.strokeColor,
		backgroundColor: style.backgroundColor,
		fillStyle: isPath || isText || isFrame ? "none" : style.fillStyle,
		strokeWidth: style.strokeWidth,
		strokeStyle: style.strokeStyle,
		roughness: style.roughness,
		opacity: style.opacity,
		roundness: style.roundness,
		points: isPath ? [{ x: 0, y: 0 }] : undefined,
		startBinding: null,
		endBinding: null,
		startArrowhead: style.startArrowhead,
		endArrowhead: type === "arrow" ? style.endArrowhead : "none",
		curved: style.curved,
		elbowed: style.elbowed,
		text: type === "note" ? "Заметка" : type === "frame" ? "Рамка" : undefined,
		fontFamily: style.fontFamily,
		fontSize: style.fontSize,
		// Подписи фигур и заметок по умолчанию центрируются; свободный текст берёт выравнивание из текущего стиля
		textAlign: isText ? style.textAlign : "center",
		verticalAlign: isText ? "top" : "middle",
		autoResize: isText ? true : undefined,
		groupIds: [],
		frameId: null,
		link: null,
		locked: false,
		isDeleted: false,
		zIndex,
		updated: Date.now(),
		seed: hashStringSeed(id),
	};
	return element;
}

export function updateElementFromDrag(
	element: SceneElement,
	start: ScenePoint,
	current: ScenePoint,
	modifiers: { shift: boolean; alt: boolean }
): void {
	if (element.type === "arrow" || element.type === "line") {
		const end = modifiers.shift ? constrainTo45Degrees(start, current) : current;
		element.x = start.x;
		element.y = start.y;
		element.points = [
			{ x: 0, y: 0 },
			{ x: end.x - start.x, y: end.y - start.y },
		];
		element.width = Math.max(1, Math.abs(end.x - start.x));
		element.height = Math.max(1, Math.abs(end.y - start.y));
		return;
	}

	if (element.type === "freedraw") return;

	let endX = current.x;
	let endY = current.y;
	if (modifiers.shift) {
		const width = Math.max(1, Math.abs(endX - start.x));
		const height = Math.max(1, Math.abs(endY - start.y));
		const side = Math.max(width, height);
		endX = start.x + Math.sign(endX - start.x || 1) * side;
		endY = start.y + Math.sign(endY - start.y || 1) * side;
	}

	const x1 = modifiers.alt ? start.x - (endX - start.x) : start.x;
	const y1 = modifiers.alt ? start.y - (endY - start.y) : start.y;
	const x2 = modifiers.alt ? start.x + (endX - start.x) : endX;
	const y2 = modifiers.alt ? start.y + (endY - start.y) : endY;
	element.x = Math.min(x1, x2);
	element.y = Math.min(y1, y2);
	element.width = Math.max(1, Math.abs(x2 - x1));
	element.height = Math.max(1, Math.abs(y2 - y1));
	element.updated = Date.now();
}

export function finalizeElementSize(
	element: SceneElement,
	start: ScenePoint,
	didDrag: boolean
): void {
	// Штрих, линия и стрелка завершаются нормализацией AABB, а не фиксированными размерами
	if (element.type === "freedraw") {
		normalizeElementBounds(element);
		element.updated = Date.now();
		return;
	}

	if (element.type === "arrow" || element.type === "line") {
		if (!didDrag) {
			element.x = start.x;
			element.y = start.y;
			element.points = [{ x: 0, y: 0 }, { x: 120, y: 0 }];
		}
		normalizeElementBounds(element);
		element.updated = Date.now();
		return;
	}

	if (didDrag) {
		element.width = Math.max(4, element.width);
		element.height = Math.max(4, element.height);
		return;
	}

	const size =
		element.type === "note"
			? { width: 220, height: 140 }
			: element.type === "frame"
				? { width: 320, height: 220 }
				: element.type === "text"
					? { width: 180, height: 44 }
					: { width: 120, height: 90 };
	element.x = start.x;
	element.y = start.y;
	element.width = size.width;
	element.height = size.height;
	element.updated = Date.now();
}

export function appendFreedrawPoint(
	element: SceneElement,
	worldPoint: ScenePoint
): void {
	if (element.type !== "freedraw") return;
	const points = element.points ?? [];
	const relative = {
		x: worldPoint.x - element.x,
		y: worldPoint.y - element.y,
		pressure: worldPoint.pressure,
	};
	const previous = points[points.length - 1];
	if (
		previous &&
		Math.hypot(relative.x - previous.x, relative.y - previous.y) < 1.25
	) {
		return;
	}
	points.push(relative);
	element.points = points;
	element.updated = Date.now();
}
