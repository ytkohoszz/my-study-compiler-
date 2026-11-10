import { FontFamilyType, TextAlignType } from "../scene/types";
import {
	TEXT_FONT_WEIGHT,
	TEXT_LINE_HEIGHT,
	getCanvasFontFamily,
} from "./metrics";

/** Положение и размер `<textarea>` в CSS-пикселях относительно холста. */
export interface TextEditorLayout {
	left: number;
	top: number;
	width: number;
	height: number;
	/** Размер шрифта на экране, то есть уже с учётом масштаба. */
	fontSize: number;
	/** true — строки переносятся по ширине блока, false — только по Enter. */
	wrap: boolean;
	angle: number;
	/** Точка вращения относительно левого верхнего угла поля; по умолчанию центр. */
	originX?: number;
	originY?: number;
}

/** Чем завершена правка: клавишей (Escape, Ctrl+Enter), потерей фокуса или вызовом из кода. */
export type TextEditorCloseReason = "keyboard" | "blur" | "api";

export interface TextEditorOptions {
	initialText: string;
	fontFamily: FontFamilyType;
	textAlign: TextAlignType;
	color: string;
	computeLayout: (value: string) => TextEditorLayout | null;
	onCommit: (value: string, reason: TextEditorCloseReason) => void;
	/** Колесо над полем ввода управляет холстом (масштаб, прокрутка), а не уходит в окно. */
	onWheel?: (event: WheelEvent) => void;
}

/** Запас справа, чтобы каретка в конце самой длинной строки не обрезалась. */
const CARET_SLACK_PX = 2;
/** Сразу после открытия потеря фокуса игнорируется: браузер может перебросить фокус на холст в конце pointerdown. */
const ARM_DELAY_MS = 80;

/**
 * Прозрачный `<textarea>` поверх холста: текст печатается «прямо на холсте».
 * Размеры и позицию задаёт `computeLayout`, поэтому поле всегда совпадает с тем,
 * что потом нарисует холст. Завершается по blur, Escape и Ctrl/Cmd+Enter.
 */
export class CanvasTextEditor {
	private readonly host: HTMLElement;
	private textarea: HTMLTextAreaElement | null = null;
	private options: TextEditorOptions | null = null;
	private armTimer: number | null = null;
	private armed = false;

	constructor(host: HTMLElement) {
		this.host = host;
	}

	private get win(): Window & typeof globalThis {
		const win = this.host.ownerDocument.defaultView;
		if (!win) {
			throw new Error("Не удалось определить окно редактора текста");
		}
		return win;
	}

	public open(options: TextEditorOptions): HTMLTextAreaElement {
		this.finish(true, "api");
		const doc = this.host.ownerDocument;
		const textarea = doc.createElement("textarea");
		textarea.className = "my-sc-canvas-text-editor";
		textarea.value = options.initialText;
		textarea.rows = 1;
		textarea.spellcheck = false;
		textarea.setAttribute("aria-label", "Текст элемента");
		textarea.setAttribute("autocomplete", "off");
		textarea.setAttribute("autocapitalize", "off");
		const style = textarea.style;
		style.fontFamily = getCanvasFontFamily(options.fontFamily);
		style.fontWeight = String(TEXT_FONT_WEIGHT);
		style.lineHeight = String(TEXT_LINE_HEIGHT);
		style.textAlign = options.textAlign;
		style.color = options.color;
		style.caretColor = options.color;

		this.textarea = textarea;
		this.options = options;
		this.armed = false;
		textarea.addEventListener("keydown", this.onKeyDown);
		textarea.addEventListener("blur", this.onBlur);
		textarea.addEventListener("input", this.onInput);
		textarea.addEventListener("wheel", this.onWheel, { passive: false });
		this.host.appendChild(textarea);
		this.applyLayout();
		textarea.focus({ preventScroll: true });
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		this.armTimer = this.win.setTimeout(() => {
			this.armTimer = null;
			if (this.textarea !== textarea) return;
			this.armed = true;
			if (doc.activeElement !== textarea) {
				textarea.focus({ preventScroll: true });
			}
		}, ARM_DELAY_MS);
		return textarea;
	}

	public isOpen(): boolean {
		return this.textarea !== null;
	}

	public getElement(): HTMLTextAreaElement | null {
		return this.textarea;
	}

	public getValue(): string {
		return this.textarea?.value ?? "";
	}

	/** Пересчитывает положение поля после изменения масштаба, прокрутки или размеров холста. */
	public reposition(): void {
		this.applyLayout();
	}

	public close(commit: boolean): void {
		this.finish(commit, "api");
	}

	public destroy(): void {
		this.finish(false, "api");
	}

	private readonly onKeyDown = (event: KeyboardEvent): void => {
		if (event.isComposing) return;
		const commit =
			event.key === "Escape" ||
			(event.key === "Enter" && (event.ctrlKey || event.metaKey));
		if (!commit) return;
		event.preventDefault();
		event.stopPropagation();
		this.finish(true, "keyboard");
	};

	private readonly onBlur = (): void => {
		const textarea = this.textarea;
		if (!textarea) return;
		if (!this.armed) {
			this.win.setTimeout(() => {
				if (this.textarea === textarea) textarea.focus({ preventScroll: true });
			}, 0);
			return;
		}
		this.finish(true, "blur");
	};

	private readonly onInput = (): void => {
		this.applyLayout();
	};

	private readonly onWheel = (event: WheelEvent): void => {
		this.options?.onWheel?.(event);
	};

	private applyLayout(): void {
		const textarea = this.textarea;
		const options = this.options;
		if (!textarea || !options) return;
		const layout = options.computeLayout(textarea.value);
		if (!layout) return;
		const slack = layout.wrap ? 0 : CARET_SLACK_PX;
		const shift =
			options.textAlign === "right"
				? slack
				: options.textAlign === "center"
					? slack / 2
					: 0;
		const style = textarea.style;
		style.left = `${layout.left - shift}px`;
		style.top = `${layout.top}px`;
		style.width = `${Math.max(1, layout.width + slack)}px`;
		style.height = `${Math.max(1, layout.height)}px`;
		style.fontSize = `${layout.fontSize}px`;
		style.whiteSpace = layout.wrap ? "pre-wrap" : "pre";
		style.overflowWrap = layout.wrap ? "break-word" : "normal";
		style.transformOrigin =
			layout.originX !== undefined && layout.originY !== undefined
				? `${layout.originX + shift}px ${layout.originY}px`
				: "50% 50%";
		style.transform = layout.angle ? `rotate(${layout.angle}rad)` : "";
		textarea.setAttribute("wrap", layout.wrap ? "soft" : "off");
	}

	private finish(commit: boolean, reason: TextEditorCloseReason): void {
		const textarea = this.textarea;
		const options = this.options;
		if (!textarea || !options) return;
		const value = textarea.value;
		this.detach();
		if (commit) options.onCommit(value, reason);
	}

	private detach(): void {
		const textarea = this.textarea;
		if (!textarea) return;
		// Слушатели снимаются до удаления узла, чтобы blur при удалении не вызвал повторное завершение
		textarea.removeEventListener("keydown", this.onKeyDown);
		textarea.removeEventListener("blur", this.onBlur);
		textarea.removeEventListener("input", this.onInput);
		textarea.removeEventListener("wheel", this.onWheel);
		if (this.armTimer !== null) {
			this.win.clearTimeout(this.armTimer);
			this.armTimer = null;
		}
		textarea.remove();
		this.textarea = null;
		this.options = null;
		this.armed = false;
	}
}
