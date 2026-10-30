import type { TFile } from "obsidian";

export const KEYS = {
  area: "направление",
  type: "тип",
  parent: "родитель",
  status: "статус",
  deadline: "дедлайн",
  discipline: "дисциплина",
  icon: "иконка",
} as const;

export const STATUS_DONE = "выполнено";
export const STATUS_ACTIVE = "в работе";

export const DONE_STATUSES: readonly string[] = [
  "выполнено",
  "выполнен",
  "завершён",
  "завершено",
  "готово",
  "сдано",
  "done",
];

/** Пассивные материалы: не бывают корнем проекта и не считаются в прогрессе. */
export const MATERIAL_TYPES: readonly string[] = [
  "Источник",
  "Термин",
  "Рисунок",
  "Схема",
  "Таблица",
];

export const NEW_NOTE_TYPES: readonly string[] = [
  "Подпроект",
  "Задача",
  "Конспект",
  "Источник",
  "Термин",
  "Рисунок",
  "Схема",
  "Таблица",
];

export interface StudyCompilerSettings {
  studyAreaName: string;
  newNoteFolder: string;
  showCompletedWorks: boolean;
  excludedFolders: string[];
  expandedPaths: string[];
  lastWorkPath: string;
}

export const DEFAULT_SETTINGS: StudyCompilerSettings = {
  studyAreaName: "Учёба",
  newNoteFolder: "Знания",
  showCompletedWorks: false,
  excludedFolders: ["Templates", "Шаблоны"],
  expandedPaths: [],
  lastWorkPath: "",
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
  discipline: string;
  deadline: string | null;
  icon: string;
  parentPaths: string[];
  isDone: boolean;
}

export interface TreeNode {
  item: StudyNoteItem;
  depth: number;
  hasChildren: boolean;
  done: number;
  total: number;
}