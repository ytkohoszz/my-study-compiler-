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
} as const;

export const RESERVED_YAML_KEYS: readonly string[] = [
  KEYS.area,
  KEYS.type,
  KEYS.parent,
];

export const ROOT_STATUS_ACTIVE = "В работе";
export const ROOT_STATUS_DONE = "Завершён";

/** Полный список завершающих статусов корневого проекта (объединён из v0.1.0 и v0.2.0). */
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

/**
 * Типы атомарных материалов: если у такой заметки нет ни родителя, ни детей, ни статуса/дедлайна,
 * она попадает в «🧭 Без родителя», а не засоряет список проектов.
 */
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

export interface StudyCompilerSettings {
  studyAreaName: string;
  newNoteFolder: string;
  projectGroupTab: ProjectGroupTab;
  lastUsedMaterialType: string;
  excludedFolders: string[];
  excludedTitlePrefixes: string[];
  excludedTags: string[];
  expandedPaths: string[];
  lastWorkPath: string;
  focusedBranchByWork: Record<string, string>;
}

export const DEFAULT_SETTINGS: StudyCompilerSettings = {
  studyAreaName: "Учёба",
  newNoteFolder: "Знания",
  projectGroupTab: "active",
  lastUsedMaterialType: "Термин",
  excludedFolders: ["Templates", "Шаблоны", "Знания/Карточки", "Знания/Сборки"],
  excludedTitlePrefixes: ["Учёба — ", "Шаблон", "Template"],
  excludedTags: ["шаблон", "template"],
  expandedPaths: [],
  lastWorkPath: "",
  focusedBranchByWork: {},
};

export interface WorkMetaBadge {
  icon: string;
  color: string;
  label: string;
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