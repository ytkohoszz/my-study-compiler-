// C:\Users\user\dev\my-study-compiler\src\render\shapes.ts
import {
	ArrowheadType,
	SceneElement,
	ScenePoint,
	StrokeStyle,
} from "../scene/types";
import { getConnectorPolyline } from "../hit/hitTest";
import {
	SeededRandom,
	drawRoughLine,
	renderFreedrawStroke,
	renderPatternFill,
} from "./rough";
import {
	TEXT_LINE_HEIGHT,
	clampFontSize,
	getCanvasFontFamily,
	getContainerTextBox,
	getDefaultTextColor,
	getTextDisplayString,
	getTextFont,
	getTextWrapWidth,
	isAutoSizeText,
	wrapMultilineText,
} from "../text/metrics";

export function applyStrokeDash(
	ctx: CanvasRenderingContext2D,
	style: StrokeStyle,
	strokeWidth: number
): void {
	if (style === "dashed") {
		ctx.setLineDash([strokeWidth * 3.5, strokeWidth * 2.2]);
	} else if (style === "dotted") {
		ctx.setLineDash([strokeWidth * 1.1, strokeWidth * 2]);
	} else {
		ctx.setLineDash([]);
	}
}

function buildRoundedRectPath(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number
): void {
	const radius = Math.max(0, Math.min(r, w / 2, h / 2));
	ctx.beginPath();
	if (radius <= 0.5) {
		ctx.rect(x, y, w, h);
		return;
	}
	ctx.moveTo(x + radius, y);
	ctx.lineTo(x + w - radius, y);
	ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
	ctx.lineTo(x + w, y + h - radius);
	ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
	ctx.lineTo(x + radius, y + h);
	ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
	ctx.lineTo(x, y + radius);
	ctx.quadraticCurveTo(x, y, x + radius, y);
	ctx.closePath();
}

function drawArrowhead(
	ctx: CanvasRenderingContext2D,
	type: ArrowheadType | undefined,
	tipX: number,
	tipY: number,
	fromX: number,
	fromY: number,
	strokeColor: string,
	strokeWidth: number
): void {
	if (!type || type === "none") return;

	const angle = Math.atan2(tipY - fromY, tipX - fromX);
	const size = Math.max(9, strokeWidth * 3.6);

	ctx.save();
	ctx.translate(tipX, tipY);
	ctx.rotate(angle);
	ctx.setLineDash([]);
	ctx.strokeStyle = strokeColor;
	ctx.fillStyle = strokeColor;
	ctx.lineWidth = Math.max(1.5, strokeWidth);
	ctx.lineCap = "round";
	ctx.lineJoin = "round";

	if (type === "arrow") {
		ctx.beginPath();
		ctx.moveTo(-size, -size * 0.55);
		ctx.lineTo(0, 0);
		ctx.lineTo(-size, size * 0.55);
		ctx.stroke();
	} else if (type === "triangle") {
		ctx.beginPath();
		ctx.moveTo(0, 0);
		ctx.lineTo(-size, -size * 0.58);
		ctx.lineTo(-size, size * 0.58);
		ctx.closePath();
		ctx.fill();
	} else if (type === "circle") {
		const r = size * 0.42;
		ctx.beginPath();
		ctx.arc(-r, 0, r, 0, Math.PI * 2);
		ctx.fill();
	} else if (type === "diamond") {
		const d = size * 0.55;
		ctx.beginPath();
		ctx.moveTo(0, 0);
		ctx.lineTo(-d, -d * 0.65);
		ctx.lineTo(-d * 2, 0);
		ctx.lineTo(-d, d * 0.65);
		ctx.closePath();
		ctx.fill();
	} else if (type === "bar") {
		ctx.beginPath();
		ctx.moveTo(-2, -size * 0.6);
		ctx.lineTo(-2, size * 0.6);
		ctx.stroke();
	}

	ctx.restore();
}

export function renderTextContent(
	ctx: CanvasRenderingContext2D,
	el: SceneElement,
	boxX: number,
	boxY: number,
	boxW: number,
	boxH: number,
	textStr: string,
	colorOverride?: string
): void {
	if (!textStr) return;

	ctx.save();
	const fontPx = clampFontSize(el.fontSize || 20);
	const lineHeight = fontPx * TEXT_LINE_HEIGHT;
	ctx.font = getTextFont(fontPx, el.fontFamily);
	ctx.fillStyle = colorOverride || el.strokeColor || "#ffffff";
	ctx.textBaseline = "middle";

	const displayStr = getTextDisplayString(textStr);
	const lines = isAutoSizeText(el)
		? displayStr.split(/\r?\n/)
		: wrapMultilineText(ctx, displayStr, getTextWrapWidth(boxW));
	const totalH = lines.length * lineHeight;

	let startY = boxY;
	if (el.verticalAlign === "middle") {
		startY = boxY + (boxH - totalH) / 2;
	} else if (el.verticalAlign === "bottom") {
		startY = boxY + boxH - totalH;
	}

	let tx = boxX;
	if (el.textAlign === "center") {
		ctx.textAlign = "center";
		tx = boxX + boxW / 2;
	} else if (el.textAlign === "right") {
		ctx.textAlign = "right";
		tx = boxX + boxW;
	} else {
		ctx.textAlign = "left";
	}
	for (let i = 0; i < lines.length; i++) {
		ctx.fillText(lines[i]!, tx, startY + i * lineHeight + lineHeight / 2);
	}

	ctx.restore();
}

export function renderSceneElement(
	ctx: CanvasRenderingContext2D,
	el: SceneElement,
	opts: {
		getImage: (el: SceneElement) => HTMLImageElement | null;
		boundTextElement?: SceneElement | null;
		isEditingText?: boolean;
		theme?: "dark" | "light";
	}
): void {
	if (el.isDeleted) return;

	ctx.save();
	ctx.globalAlpha = Math.max(0.05, Math.min(1, (el.opacity ?? 100) / 100));

	const cx = el.x + el.width / 2;
	const cy = el.y + el.height / 2;
	if (el.angle) {
		ctx.translate(cx, cy);
		ctx.rotate(el.angle);
		ctx.translate(-cx, -cy);
	}

	const rng = new SeededRandom(el.seed ?? 1);
	ctx.strokeStyle = el.strokeColor || "#e5a158";
	ctx.lineWidth = Math.max(1, el.strokeWidth || 2);
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	applyStrokeDash(ctx, el.strokeStyle, ctx.lineWidth);

	if (el.type === "rectangle" || el.type === "note" || el.type === "frame") {
		const r =
			el.type === "note"
				? 10
				: el.type === "frame"
					? 8
					: el.roundness ?? 0;

		buildRoundedRectPath(ctx, el.x, el.y, el.width, el.height, r);

		if (el.type === "frame") {
			ctx.fillStyle = "rgba(255, 255, 255, 0.015)";
			ctx.fill();
			ctx.strokeStyle = "rgba(160, 174, 192, 0.55)";
			ctx.lineWidth = 1.5;
			ctx.setLineDash([6, 4]);
			ctx.stroke();

			const frameTitle = el.text || "Рамка";
			ctx.font = `600 13px ${getCanvasFontFamily("normal")}`;
			ctx.fillStyle = "rgba(203, 213, 224, 0.85)";
			ctx.textAlign = "left";
			ctx.textBaseline = "bottom";
			ctx.fillText(frameTitle, el.x + 4, el.y - 6);
		} else {
			renderPatternFill(
				ctx,
				el.x,
				el.y,
				el.width,
				el.height,
				el.fillStyle,
				el.backgroundColor,
				el.strokeWidth,
				el.roughness,
				el.seed ?? 1
			);

			if (el.roughness > 0 && r <= 2) {
				ctx.beginPath();
				drawRoughLine(ctx, el.x, el.y, el.x + el.width, el.y, el.roughness, rng);
				drawRoughLine(
					ctx,
					el.x + el.width,
					el.y,
					el.x + el.width,
					el.y + el.height,
					el.roughness,
					rng
				);
				drawRoughLine(
					ctx,
					el.x + el.width,
					el.y + el.height,
					el.x,
					el.y + el.height,
					el.roughness,
					rng
				);
				drawRoughLine(ctx, el.x, el.y + el.height, el.x, el.y, el.roughness, rng);
				ctx.stroke();
			} else {
				buildRoundedRectPath(ctx, el.x, el.y, el.width, el.height, r);
				ctx.stroke();
			}

			// Уголок заметки-карточки (note)
			if (el.type === "note") {
				const fold = 14;
				ctx.beginPath();
				ctx.moveTo(el.x + el.width - fold, el.y);
				ctx.lineTo(el.x + el.width - fold, el.y + fold);
				ctx.lineTo(el.x + el.width, el.y + fold);
				ctx.stroke();
			}
		}
	} else if (el.type === "diamond") {
		const top = { x: cx, y: el.y };
		const right = { x: el.x + el.width, y: cy };
		const bottom = { x: cx, y: el.y + el.height };
		const left = { x: el.x, y: cy };

		ctx.beginPath();
		ctx.moveTo(top.x, top.y);
		ctx.lineTo(right.x, right.y);
		ctx.lineTo(bottom.x, bottom.y);
		ctx.lineTo(left.x, left.y);
		ctx.closePath();

		renderPatternFill(
			ctx,
			el.x,
			el.y,
			el.width,
			el.height,
			el.fillStyle,
			el.backgroundColor,
			el.strokeWidth,
			el.roughness,
			el.seed ?? 1
		);

		if (el.roughness > 0) {
			ctx.beginPath();
			drawRoughLine(ctx, top.x, top.y, right.x, right.y, el.roughness, rng);
			drawRoughLine(ctx, right.x, right.y, bottom.x, bottom.y, el.roughness, rng);
			drawRoughLine(ctx, bottom.x, bottom.y, left.x, left.y, el.roughness, rng);
			drawRoughLine(ctx, left.x, left.y, top.x, top.y, el.roughness, rng);
			ctx.stroke();
		} else {
			ctx.beginPath();
			ctx.moveTo(top.x, top.y);
			ctx.lineTo(right.x, right.y);
			ctx.lineTo(bottom.x, bottom.y);
			ctx.lineTo(left.x, left.y);
			ctx.closePath();
			ctx.stroke();
		}
	} else if (el.type === "ellipse") {
		const rx = Math.max(1, el.width / 2);
		const ry = Math.max(1, el.height / 2);
		ctx.beginPath();
		ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);

		renderPatternFill(
			ctx,
			el.x,
			el.y,
			el.width,
			el.height,
			el.fillStyle,
			el.backgroundColor,
			el.strokeWidth,
			el.roughness,
			el.seed ?? 1
		);

		ctx.beginPath();
		ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
		ctx.stroke();

		if (el.roughness > 0) {
			const off = el.roughness * 1.1;
			ctx.beginPath();
			ctx.ellipse(
				cx + rng.offset(off),
				cy + rng.offset(off),
				Math.max(1, rx + rng.offset(off)),
				Math.max(1, ry + rng.offset(off)),
				rng.offset(0.04),
				0,
				Math.PI * 2
			);
			ctx.stroke();
		}
	} else if (el.type === "arrow" || el.type === "line") {
		const pts = getConnectorPolyline(el);
		if (pts.length >= 2) {
			ctx.beginPath();
			if (el.roughness > 0) {
				for (let i = 0; i < pts.length - 1; i++) {
					drawRoughLine(
						ctx,
						pts[i]!.x,
						pts[i]!.y,
						pts[i + 1]!.x,
						pts[i + 1]!.y,
						el.roughness,
						rng
					);
				}
				ctx.stroke();
			} else {
				ctx.moveTo(pts[0]!.x, pts[0]!.y);
				for (let i = 1; i < pts.length; i++) {
					ctx.lineTo(pts[i]!.x, pts[i]!.y);
				}
				ctx.stroke();
			}

			if (el.type === "arrow") {
				const first = pts[0]!;
				const second = pts[1]!;
				const last = pts[pts.length - 1]!;
				const beforeLast = pts[pts.length - 2]!;

				drawArrowhead(
					ctx,
					el.startArrowhead,
					first.x,
					first.y,
					second.x,
					second.y,
					el.strokeColor,
					el.strokeWidth
				);
				drawArrowhead(
					ctx,
					el.endArrowhead ?? "arrow",
					last.x,
					last.y,
					beforeLast.x,
					beforeLast.y,
					el.strokeColor,
					el.strokeWidth
				);
			}
		}
	} else if (el.type === "freedraw") {
		renderFreedrawStroke(
			ctx,
			el.x,
			el.y,
			el.points ?? [],
			el.strokeColor,
			el.strokeWidth
		);
	} else if (el.type === "image") {
		const img = opts.getImage(el);
		if (img && img.complete && img.naturalWidth > 0) {
			ctx.save();
			if (el.roundness && el.roundness > 0) {
				buildRoundedRectPath(
					ctx,
					el.x,
					el.y,
					el.width,
					el.height,
					el.roundness
				);
				ctx.clip();
			}
			ctx.drawImage(img, el.x, el.y, el.width, el.height);
			ctx.restore();
		} else {
			buildRoundedRectPath(ctx, el.x, el.y, el.width, el.height, 8);
			ctx.fillStyle = "rgba(30, 34, 42, 0.75)";
			ctx.fill();
			ctx.strokeStyle = "rgba(229, 161, 88, 0.5)";
			ctx.stroke();
			renderTextContent(
				ctx,
				el,
				el.x + 8,
				el.y + 8,
				el.width - 16,
				el.height - 16,
				"🖼 Загрузка изображения…",
				"#a0aec0"
			);
		}
	} else if (el.type === "text" && !el.containerId) {
		if (!opts.isEditingText) {
			renderTextContent(
				ctx,
				el,
				el.x,
				el.y,
				el.width,
				el.height,
				el.text ?? "",
				el.strokeColor || getDefaultTextColor(opts.theme ?? "dark")
			);
		}
	}

	// Отрисовка текста внутри фигуры (если у фигуры есть el.text или boundTextElement)
	if (
		(el.type === "rectangle" ||
			el.type === "diamond" ||
			el.type === "ellipse" ||
			el.type === "note") &&
		!opts.isEditingText
	) {
		const textSource = opts.boundTextElement ?? (el.text ? el : null);
		if (textSource && textSource.text) {
			const box = getContainerTextBox(el);
			renderTextContent(
				ctx,
				textSource,
				box.x,
				box.y,
				box.width,
				box.height,
				textSource.text,
				opts.boundTextElement
					? opts.boundTextElement.strokeColor
					: getDefaultTextColor(opts.theme ?? "dark")
			);
		}
	}

	// Значок внешней/внутренней ссылки в правом верхнем углу элемента
	if (el.link && el.type !== "text") {
		ctx.save();
		ctx.setLineDash([]);
		ctx.font = `600 12px ${getCanvasFontFamily("normal")}`;
		ctx.fillStyle = "#e5a158";
		ctx.textAlign = "right";
		ctx.textBaseline = "top";
		ctx.fillText("🔗", el.x + el.width - 6, el.y + 6);
		ctx.restore();
	}

	ctx.restore();
}