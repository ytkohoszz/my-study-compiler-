// Scene v2 data model.

export type SceneElementType =
	| "rectangle"
	| "diamond"
	| "ellipse"
	| "arrow"
	| "line"
	| "freedraw"
	| "text"
	| "image"
	| "frame"
	| "note";

export type FillStyle = "solid" | "hachure" | "cross-hatch" | "none";
export type StrokeStyle = "solid" | "dashed" | "dotted";
export type ArrowheadType = "none" | "arrow" | "triangle" | "circle" | "diamond" | "bar";
export type FontFamilyType = "hand" | "normal" | "mono";
export type TextAlignType = "left" | "center" | "right";
export type VerticalAlignType = "top" | "middle" | "bottom";

export type CanvasToolId =
	| "select"
	| "hand"
	| "rectangle"
	| "diamond"
	| "ellipse"
	| "arrow"
	| "line"
	| "freedraw"
	| "text"
	| "image"
	| "note"
	| "frame"
	| "eraser";

export interface ScenePoint {
	x: number;
	y: number;
	pressure?: number;
}

export interface ElementBinding {
	elementId: string;
	/** Нормализованные координаты точки привязки относительно центра/бокса (-1..1) */
	focus: number;
	gap: number;
	anchor?: "top" | "bottom" | "left" | "right" | "center";
}

export interface SceneElement {
	id: string;
	type: SceneElementType;
	x: number;
	y: number;
	width: number;
	height: number;
	angle: number;
	strokeColor: string;
	backgroundColor: string;
	fillStyle: FillStyle;
	strokeWidth: number;
	strokeStyle: StrokeStyle;
	/** 0 = гладкий (architect), 1 = обычный (artist), 2 = небрежный (cartoonist) */
	roughness: number;
	/** 0..100 */
	opacity: number;
	/** Скругление углов в px (для прямоугольника/карточки/стрелки) */
	roundness: number;
	/** Точки относительно (x, y) для line / arrow / freedraw */
	points?: ScenePoint[];
	startBinding?: ElementBinding | null;
	endBinding?: ElementBinding | null;
	startArrowhead?: ArrowheadType;
	endArrowhead?: ArrowheadType;
	/** Прямая | скруглённая кривая | ортогональная с изломами */
	elbowed?: boolean;
	curved?: boolean;
	text?: string;
	fontFamily: FontFamilyType;
	fontSize: number;
	textAlign: TextAlignType;
	verticalAlign: VerticalAlignType;
	/** ID фигуры-контейнера, если это привязанный текст внутри фигуры, либо ID текстового элемента у фигуры */
	containerId?: string | null;
	boundTextId?: string | null;
	groupIds: string[];
	frameId?: string | null;
	/** Вики-ссылка [[Заметка]] или внешний URL */
	link?: string | null;
	/** ID файла в Scene.files (для type === "image") */
	fileId?: string | null;
	aspectRatio?: number;
	locked: boolean;
	isDeleted: boolean;
	zIndex: number;
	updated: number;
	seed?: number;
}

export interface ElementStyleDefaults {
	strokeColor: string;
	backgroundColor: string;
	fillStyle: FillStyle;
	strokeWidth: number;
	strokeStyle: StrokeStyle;
	roughness: number;
	opacity: number;
	roundness: number;
	fontFamily: FontFamilyType;
	fontSize: number;
	textAlign: TextAlignType;
	verticalAlign: VerticalAlignType;
	startArrowhead: ArrowheadType;
	endArrowhead: ArrowheadType;
	curved: boolean;
	elbowed: boolean;
}

export interface SceneAppState {
	scrollX: number;
	scrollY: number;
	zoom: number;
	grid: boolean;
	gridSize: number;
	snapToGrid: boolean;
	snapToObjects: boolean;
	theme: "dark" | "light";
	keepToolActive: boolean;
	activeTool: CanvasToolId;
	currentStyle: ElementStyleDefaults;
}

export interface SceneFileEntry {
	id: string;
	mime: string;
	dataURL?: string;
	vaultPath?: string;
	created?: number;
}

export interface Scene {
	version: 2;
	title?: string;
	deleted?: boolean;
	order?: number;
	elements: SceneElement[];
	appState: SceneAppState;
	files: Record<string, SceneFileEntry>;
}

export interface AABB {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	width: number;
	height: number;
	cx: number;
	cy: number;
}

export type HandleKind =
	| "nw"
	| "n"
	| "ne"
	| "e"
	| "se"
	| "s"
	| "sw"
	| "w"
	| "rotate"
	| "point"
	| "midpoint";

export interface HandleDescriptor {
	kind: HandleKind;
	x: number;
	y: number;
	pointIndex?: number;
	elementId?: string;
}

export interface SnapGuideLine {
	type: "vertical" | "horizontal";
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export const DEFAULT_ELEMENT_STYLE: ElementStyleDefaults = {
	strokeColor: "#e5a158",
	backgroundColor: "rgba(229, 161, 88, 0.14)",
	fillStyle: "solid",
	strokeWidth: 2,
	strokeStyle: "solid",
	roughness: 0,
	opacity: 100,
	roundness: 8,
	fontFamily: "normal",
	fontSize: 18,
	textAlign: "center",
	verticalAlign: "middle",
	startArrowhead: "none",
	endArrowhead: "arrow",
	curved: false,
	elbowed: false,
};

export function createDefaultAppState(): SceneAppState {
	return {
		scrollX: 0,
		scrollY: 0,
		zoom: 1,
		grid: true,
		gridSize: 20,
		snapToGrid: true,
		snapToObjects: true,
		theme: "dark",
		keepToolActive: false,
		activeTool: "select",
		currentStyle: { ...DEFAULT_ELEMENT_STYLE },
	};
}

export function createEmptyScene(title?: string): Scene {
	return {
		version: 2,
		title,
		elements: [],
		appState: createDefaultAppState(),
		files: {},
	};
}

export function cloneSceneElement(el: SceneElement): SceneElement {
	return {
		...el,
		points: el.points ? el.points.map((p) => ({ ...p })) : undefined,
		startBinding: el.startBinding ? { ...el.startBinding } : el.startBinding,
		endBinding: el.endBinding ? { ...el.endBinding } : el.endBinding,
		groupIds: [...(el.groupIds ?? [])],
	};
}

export function generateElementId(prefix = "el"): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function hashStringSeed(id: string): number {
	let h = 2166136261;
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return Math.abs(h) || 1;
}