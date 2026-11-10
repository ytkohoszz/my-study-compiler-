import { FontFamilyType, SceneElement, TextAlignType } from "../scene/types";

export const TEXT_LINE_HEIGHT = 1.3;
export const TEXT_FONT_WEIGHT = 500;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 400;
export const MIN_TEXT_WRAP_WIDTH = 24;
export const CONTAINER_TEXT_PADDING = 12;

/** Размеры шрифта панели свойств: S / M / L / XL (px). */
export const FONT_SIZE_PRESETS = { S: 16, M: 20, L: 28, XL: 36 } as const;
export type FontSizePreset = keyof typeof FONT_SIZE_PRESETS;

export const LIGHT_THEME_TEXT_COLOR = "#1e1e1e";
export const DARK_THEME_TEXT_COLOR = "#ffffff";

export function getDefaultTextColor(theme: "dark" | "light"): string {
	return theme === "light" ? LIGHT_THEME_TEXT_COLOR : DARK_THEME_TEXT_COLOR;
}

export function getFontSizePreset(fontSize: number): FontSizePreset | null {
	for (const [name, size] of Object.entries(FONT_SIZE_PRESETS)) {
		if (Math.abs(size - fontSize) < 0.01) return name as FontSizePreset;
	}
	return null;
}

export function clampFontSize(size: number): number {
	if (!Number.isFinite(size)) return FONT_SIZE_PRESETS.M;
	return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
}

export function getCanvasFontFamily(family: FontFamilyType): string {
	switch (family) {
		case "hand":
			return '"Virgil", "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive, sans-serif';
		case "mono":
			return '"JetBrains Mono", "Cascadia Code", "Fira Code", Consolas, monospace';
		default:
			return '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif';
	}
}

/** Один и тот же шрифт используют холст, измерение и `<textarea>`, поэтому геометрия совпадает пиксель в пиксель. */
export function getTextFont(fontSize: number, family: FontFamilyType): string {
	return `${TEXT_FONT_WEIGHT} ${clampFontSize(fontSize)}px ${getCanvasFontFamily(family)}`;
}

/** Отображаем [[Заметка|Алиас]] аккуратно, сохраняя индикатор ссылки. */
export function getTextDisplayString(text: string): string {
	return text.replace(
		/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g,
		(_m, target: string, alias?: string) => `🔗 ${(alias || target).trim()}`
	);
}

/** Свободный текст с автоподбором ширины не переносит строки сам — только по Enter. */
export function isAutoSizeText(el: SceneElement): boolean {
	return el.type === "text" && !el.containerId && el.autoResize === true;
}

export function getTextWrapWidth(width: number): number {
	return Math.max(MIN_TEXT_WRAP_WIDTH, width);
}

export function wrapMultilineText(
	ctx: CanvasRenderingContext2D,
	text: string,
	maxWidth: number
): string[] {
	const rawLines = text.split(/\r?\n/);
	const out: string[] = [];

	if (maxWidth <= 20) {
		return rawLines;
	}

	for (const paragraph of rawLines) {
		if (!paragraph) {
			out.push("");
			continue;
		}
		const words = paragraph.split(/\s+/);
		let currentLine = "";

		for (const word of words) {
			const candidate = currentLine ? `${currentLine} ${word}` : word;
			if (ctx.measureText(candidate).width <= maxWidth) {
				currentLine = candidate;
			} else {
				if (currentLine) out.push(currentLine);
				// Если одно слово длиннее ширины контейнера — режем посимвольно
				if (ctx.measureText(word).width > maxWidth) {
					let chunk = "";
					for (const ch of Array.from(word)) {
						if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
							out.push(chunk);
							chunk = ch;
						} else {
							chunk += ch;
						}
					}
					currentLine = chunk;
				} else {
					currentLine = word;
				}
			}
		}
		if (currentLine) out.push(currentLine);
	}

	return out.length > 0 ? out : [""];
}

export interface TextBlockMetrics {
	lines: string[];
	width: number;
	height: number;
	lineHeight: number;
	fontSize: number;
}

/**
 * Измеряет текстовый блок через Canvas 2D: ширина — самая длинная строка
 * (или `wrapWidth`, если текст переносится), высота — `строк * fontSize * 1.3`.
 */
export function measureTextBlock(
	ctx: CanvasRenderingContext2D,
	text: string,
	fontSize: number,
	family: FontFamilyType,
	wrapWidth: number | null = null
): TextBlockMetrics {
	const size = clampFontSize(fontSize);
	ctx.font = getTextFont(size, family);
	const display = getTextDisplayString(text);
	const lines =
		wrapWidth === null
			? display.split(/\r?\n/)
			: wrapMultilineText(ctx, display, getTextWrapWidth(wrapWidth));
	let longest = 0;
	for (const line of lines) {
		longest = Math.max(longest, ctx.measureText(line).width);
	}
	const lineHeight = size * TEXT_LINE_HEIGHT;
	return {
		lines,
		width: wrapWidth === null ? longest : getTextWrapWidth(wrapWidth),
		height: lines.length * lineHeight,
		lineHeight,
		fontSize: size,
	};
}

const measureContexts = new WeakMap<Document, CanvasRenderingContext2D | null>();

/** Невидимый (offscreen) Canvas 2D только для измерения текста. */
export function getMeasureContext(doc: Document): CanvasRenderingContext2D | null {
	if (measureContexts.has(doc)) return measureContexts.get(doc) ?? null;
	const context = doc.createElement("canvas").getContext("2d");
	measureContexts.set(doc, context);
	return context;
}

export interface TextAnchor {
	left: number;
	center: number;
	right: number;
}

export function getTextAnchor(el: Pick<SceneElement, "x" | "width">): TextAnchor {
	return { left: el.x, center: el.x + el.width / 2, right: el.x + el.width };
}

/** Выравнивание определяет, какой край остаётся на месте, когда текст растёт: левый, центр или правый. */
export function getAnchoredTextX(
	anchor: TextAnchor,
	align: TextAlignType,
	width: number
): number {
	if (align === "center") return anchor.center - width / 2;
	if (align === "right") return anchor.right - width;
	return anchor.left;
}

/** Подгоняет `width`/`height` свободного текста под содержимое; для привязанного к фигуре текста ничего не делает. */
export function fitTextElementToContent(
	ctx: CanvasRenderingContext2D,
	el: SceneElement,
	anchor?: TextAnchor
): void {
	if (el.type !== "text" || el.containerId) return;
	const fixedWidth = el.autoResize === true ? null : getTextWrapWidth(el.width);
	const metrics = measureTextBlock(
		ctx,
		el.text ?? "",
		el.fontSize,
		el.fontFamily,
		fixedWidth
	);
	if (fixedWidth === null && anchor) {
		el.x = getAnchoredTextX(anchor, el.textAlign, metrics.width);
	}
	el.width = metrics.width;
	el.height = metrics.height;
}

export interface TextBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Область внутри фигуры, где рисуется и редактируется её подпись. */
export function getContainerTextBox(
	container: Pick<SceneElement, "type" | "x" | "y" | "width" | "height">
): TextBox {
	const pad =
		container.type === "diamond"
			? Math.min(24, container.width * 0.18)
			: CONTAINER_TEXT_PADDING;
	return {
		x: container.x + pad,
		y: container.y + pad,
		width: Math.max(20, container.width - pad * 2),
		height: Math.max(20, container.height - pad * 2),
	};
}
