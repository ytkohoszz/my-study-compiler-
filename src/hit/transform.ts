import { HandleKind, ScenePoint } from "../scene/types";
import { rotatePoint, unrotatePoint } from "./hitTest";

export const MIN_RESIZE_SIZE = 4;

export type ResizeHandleKind = Extract<
	HandleKind,
	"nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w"
>;

const RESIZE_HANDLES: ReadonlySet<string> = new Set([
	"nw",
	"n",
	"ne",
	"e",
	"se",
	"s",
	"sw",
	"w",
]);

export function isResizeHandle(kind: HandleKind): kind is ResizeHandleKind {
	return RESIZE_HANDLES.has(kind);
}

export interface ResizeBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ResizeOptions {
	keepRatio?: boolean;
	/** Отношение ширины к высоте для `keepRatio`; по умолчанию берётся из исходной рамки. */
	ratio?: number;
	minSize?: number;
}

/**
 * Считает новую рамку, когда ручка `handle` перетаскивается в точку `pointer` (мировые координаты).
 * Поворот `angle` учитывается: ручка двигается вдоль осей самого элемента,
 * а противоположная сторона остаётся на месте и в мировых координатах.
 */
export function resizeBoxFromHandle(
	start: ResizeBox,
	angle: number,
	handle: ResizeHandleKind,
	pointer: ScenePoint,
	options: ResizeOptions = {}
): ResizeBox {
	const minSize = options.minSize ?? MIN_RESIZE_SIZE;
	const startCx = start.x + start.width / 2;
	const startCy = start.y + start.height / 2;
	const local = unrotatePoint(pointer.x, pointer.y, startCx, startCy, angle);

	let left = start.x;
	let right = start.x + start.width;
	let top = start.y;
	let bottom = start.y + start.height;
	if (handle.includes("w")) left = Math.min(local.x, right - minSize);
	if (handle.includes("e")) right = Math.max(local.x, left + minSize);
	if (handle.includes("n")) top = Math.min(local.y, bottom - minSize);
	if (handle.includes("s")) bottom = Math.max(local.y, top + minSize);

	if (options.keepRatio) {
		const ratio =
			options.ratio && options.ratio > 0
				? options.ratio
				: start.width / Math.max(1, start.height);
		const width = right - left;
		const height = bottom - top;
		if (handle === "n" || handle === "s") {
			const nextWidth = height * ratio;
			left = startCx - nextWidth / 2;
			right = startCx + nextWidth / 2;
		} else if (handle === "e" || handle === "w") {
			const nextHeight = width / ratio;
			top = startCy - nextHeight / 2;
			bottom = startCy + nextHeight / 2;
		} else if (width / Math.max(1, height) > ratio) {
			const nextHeight = width / ratio;
			if (handle.includes("n")) top = bottom - nextHeight;
			else bottom = top + nextHeight;
		} else {
			const nextWidth = height * ratio;
			if (handle.includes("w")) left = right - nextWidth;
			else right = left + nextWidth;
		}
	}

	return placeBox(start, angle, left, top, right - left, bottom - top);
}

/**
 * Ставит рамку `width` × `height` с левым верхним углом (`left`, `top`) в системе координат
 * исходной рамки `start` до поворота и возвращает её положение в мировых координатах.
 * Поворот выполняется вокруг центра `start`, поэтому закреплённая сторона остаётся на месте.
 */
export function placeBox(
	start: ResizeBox,
	angle: number,
	left: number,
	top: number,
	width: number,
	height: number
): ResizeBox {
	const center = rotatePoint(
		left + width / 2,
		top + height / 2,
		start.x + start.width / 2,
		start.y + start.height / 2,
		angle
	);
	return {
		x: center.x - width / 2,
		y: center.y - height / 2,
		width,
		height,
	};
}
