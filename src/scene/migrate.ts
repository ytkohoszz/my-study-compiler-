// C:\Users\user\dev\my-study-compiler\src\scene\migrate.ts
import { App, TFile, TFolder, normalizePath } from "obsidian";
import {
	ArrowheadType,
	DEFAULT_ELEMENT_STYLE,
	ElementBinding,
	FillStyle,
	FontFamilyType,
	Scene,
	SceneAppState,
	SceneElement,
	SceneElementType,
	SceneFileEntry,
	ScenePoint,
	StrokeStyle,
	TextAlignType,
	VerticalAlignType,
	createDefaultAppState,
	createEmptyScene,
	generateElementId,
	hashStringSeed,
} from "./types";

function isFiniteNum(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

function toNum(v: unknown, fallback = 0): number {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	const parsed = Number(v);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function guessMimeFromKey(key: string): string {
	const ext = key.split("?")[0]?.split(".").pop()?.toLowerCase() ?? "png";
	switch (ext) {
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		case "svg":
			return "image/svg+xml";
		case "bmp":
			return "image/bmp";
		case "avif":
			return "image/avif";
		default:
			return "image/png";
	}
}

function normalizeElementV2(
	raw: Record<string, unknown>,
	idx: number,
	filesOut: Record<string, SceneFileEntry>
): SceneElement | null {
	const rawType = String(raw["type"] ?? "rectangle");
	const validTypes: readonly SceneElementType[] = [
		"rectangle",
		"diamond",
		"ellipse",
		"arrow",
		"line",
		"freedraw",
		"text",
		"image",
		"frame",
		"note",
	];

	// Поддержка v1 типов ("rect" -> "rectangle")
	let type: SceneElementType = "rectangle";
	if (rawType === "rect") {
		type = "rectangle";
	} else if ((validTypes as readonly string[]).includes(rawType)) {
		type = rawType as SceneElementType;
	} else {
		return null;
	}

	const id =
		typeof raw["id"] === "string" && raw["id"].trim().length > 0
			? raw["id"].trim()
			: generateElementId(type);

	// Если это старый v1 arrow с x1, y1, x2, y2
	if (
		(type === "arrow" || type === "line") &&
		!Array.isArray(raw["points"]) &&
		(isFiniteNum(raw["x1"]) || isFiniteNum(raw["x2"]))
	) {
		const x1 = toNum(raw["x1"], 0);
		const y1 = toNum(raw["y1"], 0);
		const x2 = toNum(raw["x2"], 100);
		const y2 = toNum(raw["y2"], 100);
		const routing = String(raw["routing"] ?? "straight");

		const pts: ScenePoint[] = [{ x: 0, y: 0 }];
		if (routing === "curved" && isFiniteNum(raw["cx1"]) && isFiniteNum(raw["cy1"])) {
			const cx1 = toNum(raw["cx1"], (x1 + x2) / 2);
			const cy1 = toNum(raw["cy1"], y1);
			const cx2 = toNum(raw["cx2"], (x1 + x2) / 2);
			const cy2 = toNum(raw["cy2"], y2);
			pts.push({
				x: Math.round((cx1 + cx2) / 2 - x1),
				y: Math.round((cy1 + cy2) / 2 - y1),
			});
		} else if (routing === "orthogonal" && Math.abs(x2 - x1) > 8 && Math.abs(y2 - y1) > 8) {
			const midX = Math.round((x2 - x1) / 2);
			pts.push({ x: midX, y: 0 }, { x: midX, y: Math.round(y2 - y1) });
		}
		pts.push({ x: Math.round(x2 - x1), y: Math.round(y2 - y1) });

		const startBinding: ElementBinding | null =
			typeof raw["startElementId"] === "string" && raw["startElementId"]
				? {
						elementId: String(raw["startElementId"]),
						focus: 0,
						gap: 4,
						anchor:
							(raw["startAnchor"] as ElementBinding["anchor"]) ?? "center",
				  }
				: null;

		const endBinding: ElementBinding | null =
			typeof raw["endElementId"] === "string" && raw["endElementId"]
				? {
						elementId: String(raw["endElementId"]),
						focus: 0,
						gap: 4,
						anchor: (raw["endAnchor"] as ElementBinding["anchor"]) ?? "center",
				  }
				: null;

		return {
			id,
			type,
			x: Math.round(x1),
			y: Math.round(y1),
			width: Math.max(4, Math.abs(x2 - x1)),
			height: Math.max(4, Math.abs(y2 - y1)),
			angle: 0,
			strokeColor: String(raw["stroke"] || raw["strokeColor"] || "#e5a158"),
			backgroundColor: "transparent",
			fillStyle: "none",
			strokeWidth: toNum(raw["strokeWidth"], 2),
			strokeStyle: "solid",
			roughness: toNum(raw["roughness"], 0),
			opacity: toNum(raw["opacity"], 100),
			roundness: routing === "curved" ? 16 : 0,
			points: pts,
			startBinding,
			endBinding,
			startArrowhead:
				raw["startHead"] === "arrow" ? "arrow" : "none",
			endArrowhead:
				raw["endHead"] === "none" ? "none" : "arrow",
			curved: routing === "curved",
			elbowed: routing === "orthogonal",
			fontFamily: "normal",
			fontSize: 16,
			textAlign: "center",
			verticalAlign: "middle",
			groupIds: [],
			locked: false,
			isDeleted: false,
			zIndex: isFiniteNum(raw["zIndex"]) ? raw["zIndex"] : idx,
			updated: toNum(raw["updated"], Date.now()),
			seed: hashStringSeed(id),
		};
	}

	const x = toNum(raw["x"], 0);
	const y = toNum(raw["y"], 0);
	const width = Math.max(4, toNum(raw["width"], type === "text" ? 160 : 120));
	const height = Math.max(4, toNum(raw["height"], type === "text" ? 40 : 80));
	const angle = toNum(raw["angle"], 0);

	// Миграция цвета и заливки из v1 ("stroke", "fill", "color", "borderRadius")
	const strokeColor = String(
		raw["strokeColor"] ??
			raw["stroke"] ??
			raw["color"] ??
			(type === "text" ? "#ffffff" : DEFAULT_ELEMENT_STYLE.strokeColor)
	);
	const backgroundColor = String(
		raw["backgroundColor"] ??
			raw["fill"] ??
			(type === "note"
				? "rgba(229, 161, 88, 0.22)"
				: type === "frame"
					? "rgba(255, 255, 255, 0.02)"
					: DEFAULT_ELEMENT_STYLE.backgroundColor)
	);

	const rawFillStyle = String(raw["fillStyle"] ?? "solid") as FillStyle;
	const fillStyle: FillStyle = ["solid", "hachure", "cross-hatch", "none"].includes(
		rawFillStyle
	)
		? rawFillStyle
		: "solid";

	const rawStrokeStyle = String(raw["strokeStyle"] ?? "solid") as StrokeStyle;
	const strokeStyle: StrokeStyle = ["solid", "dashed", "dotted"].includes(
		rawStrokeStyle
	)
		? rawStrokeStyle
		: "solid";

	const rawFontFamily = String(raw["fontFamily"] ?? "normal") as FontFamilyType;
	const fontFamily: FontFamilyType = ["hand", "normal", "mono"].includes(
		rawFontFamily
	)
		? rawFontFamily
		: "normal";

	const rawTextAlign = String(
		raw["textAlign"] ?? (type === "text" ? "left" : "center")
	) as TextAlignType;
	const textAlign: TextAlignType = ["left", "center", "right"].includes(
		rawTextAlign
	)
		? rawTextAlign
		: "left";

	const rawVertAlign = String(
		raw["verticalAlign"] ?? (type === "text" ? "top" : "middle")
	) as VerticalAlignType;
	const verticalAlign: VerticalAlignType = ["top", "middle", "bottom"].includes(
		rawVertAlign
	)
		? rawVertAlign
		: "middle";

	let fileId = typeof raw["fileId"] === "string" ? raw["fileId"] : null;
	const legacySrcKey =
		typeof raw["srcKey"] === "string" ? raw["srcKey"].trim() : "";

	if (type === "image" && !fileId && legacySrcKey) {
		fileId = `file_${hashStringSeed(legacySrcKey).toString(36)}`;
		if (!filesOut[fileId]) {
			const isDataOrHttp =
				/^https?:\/\//i.test(legacySrcKey) ||
				legacySrcKey.startsWith("data:");
			filesOut[fileId] = {
				id: fileId,
				mime: guessMimeFromKey(legacySrcKey),
				dataURL: isDataOrHttp ? legacySrcKey : undefined,
				vaultPath: isDataOrHttp ? undefined : legacySrcKey,
				created: Date.now(),
			};
		}
	}

	let points: ScenePoint[] | undefined;
	if (Array.isArray(raw["points"])) {
		points = raw["points"]
			.map((pt): ScenePoint | null => {
				if (Array.isArray(pt) && pt.length >= 2) {
					return {
						x: toNum(pt[0], 0),
						y: toNum(pt[1], 0),
						pressure: isFiniteNum(pt[2]) ? pt[2] : undefined,
					};
				}
				if (pt && typeof pt === "object") {
					const rec = pt as Record<string, unknown>;
					return {
						x: toNum(rec["x"], 0),
						y: toNum(rec["y"], 0),
						pressure: isFiniteNum(rec["pressure"]) ? rec["pressure"] : undefined,
					};
				}
				return null;
			})
			.filter((p): p is ScenePoint => p !== null);
	}

	// Автоизвлечение [[Вики-ссылки]] в поле link, если оно ещё не задано
	let link = typeof raw["link"] === "string" ? raw["link"] : null;
	const textVal = typeof raw["text"] === "string" ? raw["text"] : undefined;
	if (!link && textVal) {
		const wikiMatch = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/.exec(
			textVal
		);
		if (wikiMatch?.[1]) {
			link = `[[${wikiMatch[1].trim()}]]`;
		}
	}

	return {
		id,
		type,
		x,
		y,
		width,
		height,
		angle,
		strokeColor,
		backgroundColor,
		fillStyle,
		strokeWidth: toNum(raw["strokeWidth"], 2),
		strokeStyle,
		roughness: toNum(raw["roughness"], 0),
		opacity: Math.max(5, Math.min(100, toNum(raw["opacity"], 100))),
		roundness: toNum(raw["roundness"] ?? raw["borderRadius"], type === "rectangle" ? 6 : 0),
		points,
		startBinding: (raw["startBinding"] as ElementBinding | null) ?? null,
		endBinding: (raw["endBinding"] as ElementBinding | null) ?? null,
		startArrowhead: (raw["startArrowhead"] as ArrowheadType) ?? "none",
		endArrowhead:
			(raw["endArrowhead"] as ArrowheadType) ??
			(type === "arrow" ? "arrow" : "none"),
		curved: Boolean(raw["curved"]),
		elbowed: Boolean(raw["elbowed"]),
		text: textVal,
		fontFamily,
		fontSize: Math.max(8, toNum(raw["fontSize"], 18)),
		textAlign,
		verticalAlign,
		containerId:
			typeof raw["containerId"] === "string" ? raw["containerId"] : null,
		boundTextId:
			typeof raw["boundTextId"] === "string" ? raw["boundTextId"] : null,
		groupIds: Array.isArray(raw["groupIds"])
			? raw["groupIds"].map(String)
			: [],
		frameId: typeof raw["frameId"] === "string" ? raw["frameId"] : null,
		link,
		fileId,
		aspectRatio: isFiniteNum(raw["aspectRatio"])
			? raw["aspectRatio"]
			: Number((width / Math.max(1, height)).toFixed(4)),
		locked: Boolean(raw["locked"]),
		isDeleted: Boolean(raw["isDeleted"]),
		zIndex: isFiniteNum(raw["zIndex"]) ? raw["zIndex"] : idx,
		updated: toNum(raw["updated"], Date.now()),
		seed: isFiniteNum(raw["seed"]) ? raw["seed"] : hashStringSeed(id),
	};
}

/**
 * Преобразует любое сохранённое значение холста (массив v1, объект `{ title, elements }` v1 или `Scene` v2)
 * в строгую структуру `Scene` v2 без потери элементов, привязок и картинок.
 */
export function migrateLegacy(rawBoard: unknown): {
	scene: Scene;
	wasMigrated: boolean;
} {
	if (!rawBoard) {
		return { scene: createEmptyScene(), wasMigrated: false };
	}

	// Сцена уже в формате v2
	if (
		typeof rawBoard === "object" &&
		!Array.isArray(rawBoard) &&
		(rawBoard as { version?: unknown }).version === 2
	) {
		const rec = rawBoard as Record<string, unknown>;
		const files: Record<string, SceneFileEntry> = {};
		if (rec["files"] && typeof rec["files"] === "object") {
			for (const [fId, fVal] of Object.entries(
				rec["files"] as Record<string, unknown>
			)) {
				if (fVal && typeof fVal === "object") {
					const fRec = fVal as Record<string, unknown>;
					files[fId] = {
						id: fId,
						mime: String(fRec["mime"] || "image/png"),
						dataURL:
							typeof fRec["dataURL"] === "string"
								? fRec["dataURL"]
								: undefined,
						vaultPath:
							typeof fRec["vaultPath"] === "string"
								? fRec["vaultPath"]
								: undefined,
						created: toNum(fRec["created"], Date.now()),
					};
				}
			}
		}

		const rawElements = Array.isArray(rec["elements"]) ? rec["elements"] : [];
		const elements: SceneElement[] = [];
		rawElements.forEach((el, i) => {
			if (el && typeof el === "object") {
				const parsed = normalizeElementV2(
					el as Record<string, unknown>,
					i,
					files
				);
				if (parsed && !parsed.isDeleted) {
					elements.push(parsed);
				}
			}
		});

		const baseState = createDefaultAppState();
		if (rec["appState"] && typeof rec["appState"] === "object") {
			const st = rec["appState"] as Partial<SceneAppState>;
			if (isFiniteNum(st.scrollX)) baseState.scrollX = st.scrollX;
			if (isFiniteNum(st.scrollY)) baseState.scrollY = st.scrollY;
			if (isFiniteNum(st.zoom)) {
				baseState.zoom = Math.max(0.1, Math.min(30, st.zoom));
			}
			if (typeof st.grid === "boolean") baseState.grid = st.grid;
			if (isFiniteNum(st.gridSize)) baseState.gridSize = st.gridSize;
			if (typeof st.snapToGrid === "boolean") {
				baseState.snapToGrid = st.snapToGrid;
			}
			if (typeof st.snapToObjects === "boolean") {
				baseState.snapToObjects = st.snapToObjects;
			}
			if (st.theme === "light" || st.theme === "dark") {
				baseState.theme = st.theme;
			}
			if (typeof st.keepToolActive === "boolean") {
				baseState.keepToolActive = st.keepToolActive;
			}
			if (st.currentStyle && typeof st.currentStyle === "object") {
				baseState.currentStyle = {
					...baseState.currentStyle,
					...st.currentStyle,
				};
			}
		}

		return {
			scene: {
				version: 2,
				title:
					typeof rec["title"] === "string" && rec["title"].trim()
						? rec["title"].trim()
						: undefined,
				deleted: rec["deleted"] === true ? true : undefined,
				order: isFiniteNum(rec["order"]) ? rec["order"] : undefined,
				elements,
				appState: baseState,
				files,
			},
			wasMigrated: false,
		};
	}

	// Миграция из формата v1 (массив элементов или { title, elements, deleted })
	const files: Record<string, SceneFileEntry> = {};
	let title: string | undefined;
	let deleted = false;
	let rawList: unknown[] = [];

	if (Array.isArray(rawBoard)) {
		rawList = rawBoard;
	} else if (typeof rawBoard === "object") {
		const rec = rawBoard as Record<string, unknown>;
		if (rec["deleted"] === true) {
			deleted = true;
		}
		if (typeof rec["title"] === "string" && rec["title"].trim()) {
			title = rec["title"].trim();
		}
		if (Array.isArray(rec["elements"])) {
			rawList = rec["elements"];
		}
	}

	const migratedElements: SceneElement[] = [];
	rawList.forEach((item, idx) => {
		if (item && typeof item === "object") {
			const parsed = normalizeElementV2(
				item as Record<string, unknown>,
				idx,
				files
			);
			if (parsed) migratedElements.push(parsed);
		}
	});

	return {
		scene: {
			version: 2,
			title,
			deleted: deleted ? true : undefined,
			order: undefined,
			elements: migratedElements,
			appState: createDefaultAppState(),
			files,
		},
		wasMigrated: true,
	};
}

/**
 * Создаёт резервную копию старых данных схем заметки перед первой записью в формате Scene v2.
 */
export async function backupLegacyAnnotationsIfNeeded(
	app: App,
	noteFile: TFile,
	rawAnnotations: unknown,
	rawLegacyPins: unknown,
	mediaFolder: string
): Promise<string | null> {
	if (
		(!rawAnnotations || typeof rawAnnotations !== "object") &&
		(!rawLegacyPins || typeof rawLegacyPins !== "object")
	) {
		return null;
	}

	const backupDir = normalizePath(
		`${mediaFolder || "Знания/Вложения"}/_backups_v1`
	);
	let cur = "";
	for (const part of backupDir.split("/").filter(Boolean)) {
		cur = cur ? `${cur}/${part}` : part;
		const existing = app.vault.getAbstractFileByPath(cur);
		if (existing instanceof TFolder) continue;
		if (existing) {
			throw new Error(`Путь резервной копии занят файлом: ${cur}`);
		}
		if (!existing) {
			try {
				await app.vault.createFolder(cur);
			} catch (error: unknown) {
				if (!(app.vault.getAbstractFileByPath(cur) instanceof TFolder)) {
					throw error;
				}
			}
		}
	}

	const safeName = noteFile.basename.replace(/[\\/:*?"<>|]/g, "_");
	const noteHash = hashStringSeed(noteFile.path).toString(36);
	const backupPath = normalizePath(
		`${backupDir}/${safeName}_${noteHash}.v1.backup.json`
	);
	if (app.vault.getAbstractFileByPath(backupPath)) {
		return backupPath;
	}

	const payload = JSON.stringify(
		{
			notePath: noteFile.path,
			backedUpAt: new Date().toISOString(),
			annotations: rawAnnotations,
			legacyPins: rawLegacyPins,
		},
		null,
		2
	);
	await app.vault.create(backupPath, payload);
	return backupPath;
}