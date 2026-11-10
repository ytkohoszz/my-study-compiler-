import type { TFile } from "obsidian";

export const KEYS = {
  area: "направление",
  type: "тип",
  parent: "родитель",
  status: "статус",
  deadline: "дедлайн",
  deadlineAlt: "срок",
  discipline: "дисциплина",
  icon: "иконка",
  templateFlag: "шаблон",
  finishedAt: "дата_завершения",
  annotations: "схемы_аннотации",
  legacyPins: "схемы_пины",
} as const;

export const RESERVED_YAML_KEYS: readonly string[] = [
  KEYS.area,
  KEYS.type,
  KEYS.parent,
  KEYS.annotations,
  KEYS.legacyPins,
];

export const ROOT_STATUS_ACTIVE = "В работе";
export const ROOT_STATUS_DONE = "Завершён";

export const ROOT_DONE_STATUSES: readonly string[] = [
  "выполнено",
  "выполнен",
  "завершён",
  "завершена",
  "завершено",
  "сдана",
  "сдан",
  "готово",
  "архив",
  "отменён",
  "отменена",
  "done",
];

export const LEGACY_MATERIAL_TYPES: readonly string[] = [
  "Источник",
  "Термин",
  "Рисунок",
  "Схема",
  "Таблица",
  "Конспект",
  "Заметка",
  "Расчёт",
  "Алгоритм",
];

export type ProjectGroupTab = "active" | "completed";
export type QuickFilterMode = "all" | "orphans";
export type DeadlineTone = "none" | "far" | "soon" | "overdue";
export type CustomPropValueKind = "auto" | "list";
export type DefaultOpenLocation = "tab" | "current" | "sidebar" | "window";
export type ViewMode = "tree" | "graph" | "schema";

export const VIEW_TYPE_STUDY_COMPILER = "my-study-compiler-workspace";

export interface CustomPropertyDraft {
  id: string;
  key: string;
  value: string;
  kind: CustomPropValueKind;
}

export interface TypeSuggestion {
  name: string;
  count: number;
}

export interface VaultPropertySchema {
  typeCounts: TypeSuggestion[];
  propertyKeys: string[];
  valuesByKey: Map<string, string[]>;
}

export interface Point {
  x: number;
  y: number;
}

export interface CameraState {
  scale: number;
  panX: number;
  panY: number;
}

export interface OpenOptions {
  rootPath?: string;
  addUnder?: string;
  schemaNotePath?: string;
  activeCanvasKey?: string;
  viewMode?: ViewMode;
  location?: DefaultOpenLocation;
}

export interface StudyCompilerViewState {
  [key: string]: unknown;
  projectPath?: string;
  focusBranchPath?: string;
  viewMode?: ViewMode;
  schemaNotePath?: string;
  activeCanvasKey?: string;
  camera?: CameraState | null;
  graphCamera?: CameraState | null;
  isFocusMode?: boolean;
  addUnder?: string;
}

export interface StudyCompilerSettings {
  studyAreaName: string;
  newNoteFolder: string;
  mediaFolder: string;
  defaultOpenLocation: DefaultOpenLocation;
  projectGroupTab: ProjectGroupTab;
  lastUsedMaterialType: string;
  autoInheritFromLinks: boolean;
  defaultAutoNoteType: string;
  excludedFolders: string[];
  excludedTitlePrefixes: string[];
  excludedTags: string[];
  expandedPaths: string[];
  lastWorkPath: string;
  focusedBranchByWork: Record<string, string>;
  graphNodePositions: Record<string, Record<string, Point>>;
}

export const DEFAULT_SETTINGS: StudyCompilerSettings = {
  studyAreaName: "Учёба",
  newNoteFolder: "Знания",
  mediaFolder: "Знания/Вложения",
  defaultOpenLocation: "tab",
  projectGroupTab: "active",
  lastUsedMaterialType: "Термин",
  autoInheritFromLinks: true,
  defaultAutoNoteType: "Заметка",
  excludedFolders: [
    "Templates",
    "Шаблоны",
    "Знания/Карточки",
    "Знания/Сборки",
    "Ежедневник",
    "Система",
    "Горизонты",
    "Грамматика",
    "Всякое",
  ],
  excludedTitlePrefixes: ["Учёба — ", "Шаблон", "Template", "Тренировка "],
  excludedTags: ["шаблон", "template"],
  expandedPaths: [],
  lastWorkPath: "",
  focusedBranchByWork: {},
  graphNodePositions: {},
};

export interface WorkMetaBadge {
  icon: string;
  color: string;
  label: string;
}

export type StudyMediaKind = "vault" | "external" | "board";

export interface StudyMediaItem {
  key: string;
  label: string;
  customTitle?: string;
  src: string;
  kind: StudyMediaKind;
  file?: TFile;
}

export type ToolType = "pan" | "select" | "text" | "rect" | "arrow";
export type ResizeHandleType = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type ArrowHandleType = "start" | "end" | "curve1" | "curve2";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasElementBase {
  id: string;
  type: "image" | "text" | "rect" | "arrow";
}

export interface ImageElement extends CanvasElementBase {
  type: "image";
  x: number;
  y: number;
  width: number;
  height: number;
  srcKey: string;
  aspectRatio?: number;
}

export interface TextElement extends CanvasElementBase {
  type: "text";
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  color: string;
}

export interface RectElement extends CanvasElementBase {
  type: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  stroke: string;
  strokeWidth: number;
  fill: string;
  borderRadius?: number;
}

export type ArrowRouting = "straight" | "curved" | "orthogonal";
export type ArrowHead = "none" | "arrow";
export type AnchorType = "top" | "bottom" | "left" | "right";

export interface ArrowElement extends CanvasElementBase {
  type: "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cx1?: number;
  cy1?: number;
  cx2?: number;
  cy2?: number;
  routing: ArrowRouting;
  startHead: ArrowHead;
  endHead: ArrowHead;
  stroke: string;
  strokeWidth: number;
  startElementId?: string;
  startAnchor?: AnchorType;
  endElementId?: string;
  endAnchor?: AnchorType;
}

export type CanvasElement = ImageElement | TextElement | RectElement | ArrowElement;
export type BoxCanvasElement = ImageElement | TextElement | RectElement;

export interface CanvasBoardData {
  title?: string;
  elements: CanvasElement[];
  deleted?: boolean;
}

export type ElementDragSnapshot =
  | {
      type: "box";
      x: number;
      y: number;
    }
  | {
      type: "arrow";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      cx1?: number;
      cy1?: number;
      cx2?: number;
      cy2?: number;
    };

export interface ResizeSnapshot {
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  aspectRatio?: number;
}

export interface SnapAnchorMatch {
  id: string;
  anchor: AnchorType;
  x: number;
  y: number;
}

export interface NodePin {
  id: number;
  x: number;
  y: number;
  text: string;
}

export interface StudyNoteItem {
  file: TFile;
  path: string;
  name: string;
  noteType: string;
  status: string;
  isCompletedRoot: boolean;
  finishedAt: string | null;
  discipline: string;
  deadline: string | null;
  icon: string;
  tags: string[];
  parentPaths: string[];
  hasExplicitParent: boolean;
  hasExplicitStudyArea: boolean;
  mediaItems: StudyMediaItem[];
  annotationCount: number;
}

export interface TreeNode {
  item: StudyNoteItem;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  directChildrenCount: number;
  descendantCount: number;
  isDirectMatch: boolean;
  children: TreeNode[];
}

export interface TreeFilterOptions {
  query: string;
  mode: QuickFilterMode;
  typeFilter: string;
}
