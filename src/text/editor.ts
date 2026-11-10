import { SceneElement } from "../scene/types";
import { getCanvasFontFamily } from "../render/shapes";

export interface TextEditorRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export class CanvasTextEditor {
	private host: HTMLElement;
	private textarea: HTMLTextAreaElement | null = null;
	private onCommit: ((value: string) => void) | null = null;
	private onCancel: (() => void) | null = null;
	private finished = false;
	private boundKeyDown?: (event: KeyboardEvent) => void;
	private boundBlur?: () => void;

	constructor(host: HTMLElement) {
		this.host = host;
	}

	public open(
		element: SceneElement,
		rect: TextEditorRect,
		onCommit: (value: string) => void,
		onCancel: () => void
	): HTMLTextAreaElement {
		this.close(false);
		this.finished = false;
		this.onCommit = onCommit;
		this.onCancel = onCancel;

		const textarea = this.host.ownerDocument.createElement("textarea");
		textarea.className = "my-sc-canvas-text-editor";
		textarea.value = element.text ?? "";
		textarea.setAttribute("aria-label", "Текст элемента");
		textarea.spellcheck = true;
		textarea.style.left = `${rect.x}px`;
		textarea.style.top = `${rect.y}px`;
		textarea.style.width = `${Math.max(80, rect.width)}px`;
		textarea.style.minHeight = `${Math.max(30, rect.height)}px`;
		textarea.style.fontFamily = getCanvasFontFamily(element.fontFamily);
		textarea.style.fontSize = `${Math.max(8, element.fontSize)}px`;
		textarea.style.textAlign = element.textAlign;
		textarea.style.color = element.strokeColor;
		textarea.style.lineHeight = "1.32";
		textarea.style.backgroundColor = "rgba(22, 24, 29, 0.96)";
		textarea.style.borderColor = element.strokeColor;

		this.boundKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				this.finish(false);
			} else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				event.stopPropagation();
				this.finish(true);
			}
		};
		this.boundBlur = () => this.finish(true);
		textarea.addEventListener("keydown", this.boundKeyDown);
		textarea.addEventListener("blur", this.boundBlur);
		textarea.addEventListener("input", () => {
			textarea.style.height = "auto";
			textarea.style.height = `${Math.max(rect.height, textarea.scrollHeight)}px`;
		});
		this.host.appendChild(textarea);
		textarea.focus({ preventScroll: true });
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		return textarea;
	}

	public isOpen(): boolean {
		return this.textarea !== null;
	}

	public getElement(): HTMLTextAreaElement | null {
		return this.textarea;
	}

	public close(commit: boolean): void {
		if (!this.textarea) return;
		this.finish(commit);
	}

	private finish(commit: boolean): void {
		const textarea = this.textarea;
		if (!textarea || this.finished) return;
		this.finished = true;
		const value = textarea.value;
		const onCommit = this.onCommit;
		const onCancel = this.onCancel;
		this.detach();
		if (commit) {
			onCommit?.(value);
		} else {
			onCancel?.();
		}
	}

	private detach(): void {
		const textarea = this.textarea;
		if (!textarea) return;
		if (this.boundKeyDown) {
			textarea.removeEventListener("keydown", this.boundKeyDown);
		}
		if (this.boundBlur) {
			textarea.removeEventListener("blur", this.boundBlur);
		}
		textarea.remove();
		this.textarea = null;
		this.boundKeyDown = undefined;
		this.boundBlur = undefined;
		this.onCommit = null;
		this.onCancel = null;
	}
}
