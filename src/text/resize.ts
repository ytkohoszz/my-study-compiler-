import { SceneElement, ScenePoint } from "../scene/types";
import {
	ResizeBox,
	ResizeHandleKind,
	placeBox,
	resizeBoxFromHandle,
} from "../hit/transform";
import {
	MIN_TEXT_WRAP_WIDTH,
	clampFontSize,
	getTextWrapWidth,
	measureTextBlock,
} from "./metrics";

export type TextSnapshot = Pick<
	SceneElement,
	| "x"
	| "y"
	| "width"
	| "height"
	| "angle"
	| "text"
	| "fontSize"
	| "fontFamily"
	| "autoResize"
>;

export interface TextGeometry {
	x: number;
	y: number;
	width: number;
	height: number;
	fontSize: number;
	autoResize: boolean;
}

/**
 * Изменение размера одиночного текста за ручку `kind`:
 * боковые ручки `e`/`w` задают ширину блока (строки переносятся автоматически),
 * угловые и `n`/`s` пропорционально масштабируют шрифт. Противоположная сторона остаётся на месте.
 */
export function resizeTextFromHandle(
	ctx: CanvasRenderingContext2D,
	snapshot: TextSnapshot,
	kind: ResizeHandleKind,
	pointer: ScenePoint
): TextGeometry {
	const start: ResizeBox = {
		x: snapshot.x,
		y: snapshot.y,
		width: snapshot.width,
		height: snapshot.height,
	};
	const angle = snapshot.angle || 0;
	const text = snapshot.text ?? "";

	if (kind === "e" || kind === "w") {
		const next = resizeBoxFromHandle(start, angle, kind, pointer, {
			minSize: MIN_TEXT_WRAP_WIDTH,
		});
		const metrics = measureTextBlock(
			ctx,
			text,
			snapshot.fontSize,
			snapshot.fontFamily,
			next.width
		);
		const left = kind === "w" ? start.x + start.width - metrics.width : start.x;
		const placed = placeBox(
			start,
			angle,
			left,
			start.y,
			metrics.width,
			metrics.height
		);
		return {
			x: placed.x,
			y: placed.y,
			width: metrics.width,
			height: metrics.height,
			fontSize: snapshot.fontSize,
			autoResize: false,
		};
	}

	const next = resizeBoxFromHandle(start, angle, kind, pointer, {
		keepRatio: true,
	});
	const fontSize = clampFontSize(
		snapshot.fontSize * (next.height / Math.max(1, start.height))
	);
	const factor = fontSize / Math.max(1, snapshot.fontSize);
	const autoResize = snapshot.autoResize === true;
	const metrics = measureTextBlock(
		ctx,
		text,
		fontSize,
		snapshot.fontFamily,
		autoResize ? null : getTextWrapWidth(snapshot.width * factor)
	);
	const left = kind.includes("w")
		? start.x + start.width - metrics.width
		: kind.includes("e")
			? start.x
			: start.x + (start.width - metrics.width) / 2;
	const top = kind.includes("n")
		? start.y + start.height - metrics.height
		: start.y;
	const placed = placeBox(start, angle, left, top, metrics.width, metrics.height);
	return {
		x: placed.x,
		y: placed.y,
		width: metrics.width,
		height: metrics.height,
		fontSize,
		autoResize,
	};
}

/**
 * Масштабирование текста вместе с группой выбранных элементов: шрифт меняется
 * по меньшему из коэффициентов, левый верхний угол переносится по общей формуле группы.
 */
export function scaleTextWithGroup(
	ctx: CanvasRenderingContext2D,
	snapshot: TextSnapshot,
	scaleX: number,
	scaleY: number,
	anchorX: number,
	anchorY: number
): TextGeometry {
	const factor = Math.min(Math.abs(scaleX), Math.abs(scaleY));
	const fontSize = clampFontSize(snapshot.fontSize * factor);
	const autoResize = snapshot.autoResize === true;
	const metrics = measureTextBlock(
		ctx,
		snapshot.text ?? "",
		fontSize,
		snapshot.fontFamily,
		autoResize ? null : getTextWrapWidth(snapshot.width * Math.abs(scaleX))
	);
	return {
		x: anchorX + (snapshot.x - anchorX) * scaleX,
		y: anchorY + (snapshot.y - anchorY) * scaleY,
		width: metrics.width,
		height: metrics.height,
		fontSize,
		autoResize,
	};
}
