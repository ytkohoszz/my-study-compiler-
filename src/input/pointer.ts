import { SceneAppState, ScenePoint } from "../scene/types";

export interface CanvasPoint {
	x: number;
	y: number;
}

export function getCanvasPoint(
	event: PointerEvent | WheelEvent,
	canvas: HTMLCanvasElement
): CanvasPoint {
	const rect = canvas.getBoundingClientRect();
	return {
		x: event.clientX - rect.left,
		y: event.clientY - rect.top,
	};
}

export function canvasPointToWorld(
	point: CanvasPoint,
	state: SceneAppState
): ScenePoint {
	const zoom = Math.max(0.1, Math.min(30, state.zoom));
	return {
		x: point.x / zoom - state.scrollX,
		y: point.y / zoom - state.scrollY,
	};
}

export function pointerToWorld(
	event: PointerEvent,
	canvas: HTMLCanvasElement,
	state: SceneAppState
): ScenePoint {
	return {
		...canvasPointToWorld(getCanvasPoint(event, canvas), state),
		pressure: event.pressure > 0 ? event.pressure : 0.5,
	};
}

export function getMidpoint(a: CanvasPoint, b: CanvasPoint): CanvasPoint {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function getDistance(a: CanvasPoint, b: CanvasPoint): number {
	return Math.hypot(b.x - a.x, b.y - a.y);
}

export function constrainTo45Degrees(
	start: ScenePoint,
	end: ScenePoint
): ScenePoint {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const length = Math.hypot(dx, dy);
	if (length < 0.001) return { x: start.x, y: start.y };

	const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
	return {
		x: start.x + Math.cos(angle) * length,
		y: start.y + Math.sin(angle) * length,
	};
}

export function isEditableTarget(target: EventTarget | null): boolean {
	if (!target || typeof target !== "object") return false;
	const candidate = target as {
		tagName?: unknown;
		isContentEditable?: unknown;
	};
	if (candidate.isContentEditable === true) return true;
	return (
		typeof candidate.tagName === "string" &&
		["INPUT", "TEXTAREA", "SELECT"].includes(candidate.tagName.toUpperCase())
	);
}
