import { CanvasToolId } from "../scene/types";

export type CanvasCommand =
	| "undo"
	| "redo"
	| "select-all"
	| "duplicate"
	| "group"
	| "ungroup"
	| "delete"
	| "move-left"
	| "move-right"
	| "move-up"
	| "move-down"
	| "bring-forward"
	| "send-backward"
	| "bring-to-front"
	| "send-to-back"
	| "toggle-keep-tool"
	| "copy-style"
	| "paste-style"
	| "escape";

export function getToolForKey(event: KeyboardEvent): CanvasToolId | null {
	if (event.ctrlKey || event.metaKey || event.altKey) return null;
	switch (event.code) {
		case "KeyV":
		case "Digit1":
			return "select";
		case "KeyH":
			return "hand";
		case "KeyR":
			return "rectangle";
		case "KeyD":
			return "diamond";
		case "KeyO":
			return "ellipse";
		case "KeyA":
			return "arrow";
		case "KeyL":
			return "line";
		case "KeyP":
			return "freedraw";
		case "KeyT":
			return "text";
		case "KeyE":
			return "eraser";
		case "KeyI":
			return "image";
		case "KeyN":
			return "note";
		default:
			return null;
	}
}

export function getCanvasCommand(event: KeyboardEvent): CanvasCommand | null {
	const key = event.key.toLowerCase();
	const command = event.ctrlKey || event.metaKey;

if (event.key === "Escape") return "escape";
	if (command && event.altKey && !event.shiftKey) {
		if (event.code === "KeyC" || key === "c") return "copy-style";
		if (event.code === "KeyV" || key === "v") return "paste-style";
		return null;
	}
	if (command) {
		if (event.code === "KeyZ" || key === "z") {
			return event.shiftKey ? "redo" : "undo";
		}
		if (event.code === "KeyY" || key === "y") return "redo";
		if (event.code === "KeyA" || key === "a") return "select-all";
		if (event.code === "KeyD" || key === "d") return "duplicate";
		if (event.code === "KeyG" || key === "g") {
			return event.shiftKey ? "ungroup" : "group";
		}
		if (event.code === "BracketRight" || event.key === "]") {
			return event.shiftKey ? "bring-to-front" : "bring-forward";
		}
		if (event.code === "BracketLeft" || event.key === "[") {
			return event.shiftKey ? "send-to-back" : "send-backward";
		}
	}

	if (!command && !event.altKey) {
		if (event.key === "Delete" || event.key === "Backspace") return "delete";
		if (event.code === "KeyK" || key === "k") return "toggle-keep-tool";
		if (event.key === "ArrowLeft") return "move-left";
		if (event.key === "ArrowRight") return "move-right";
		if (event.key === "ArrowUp") return "move-up";
		if (event.key === "ArrowDown") return "move-down";
	}

	return null;
}
