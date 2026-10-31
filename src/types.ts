import type { TFile } from "obsidian";

export const KEYS = {
  area: "направление",
  type: "тип",
  parent: "родитель",
  deadline: "дедлайн",
  deadlineAlt: "срок",
  discipline: "дисциплина",
  icon: "иконка",
  templateFlag: "шаблон",
} as const;

/** Пассивные материалы: не бывают корнем проекта. */
export const MATERIAL_TYPES: readonly string[] = [
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

export const NEW_NOTE_TYPES: readonly string[] = [
  "Подпроект",
  "Конспект",
  "Термин",
  "Источник",
  "Заметка",
  "Расчёт",
  "Алгоритм",
  "Рисунок",
  "Схема",
  "Таблица",
];

export type QuickFilterMode = "all" | "orphans";

export type DeadlineTone = "none" | "far" | "soon" | "overdue";

export type LinkCandidateKind = "missing" | "existing-free" | "has-other-parent";

export interface OutgoingLinkCandidate {
  id: string;
  sourceFile: TFile;
  sourcePath: string;
  sourceName: string;
  targetName: string;
  targetFile: TFile | null;
  targetPath: string;
  kind: LinkCandidateKind;
  existingParents: string[];
}

export interface StudyCompilerSettings {
  studyAreaName: string;
  newNoteFolder: string;
  defaultLinkNoteType: string;
  autoLinkNewNotesFromProject: boolean;
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
  defaultLinkNoteType: "Термин",
  autoLinkNewNotesFromProject: false,
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