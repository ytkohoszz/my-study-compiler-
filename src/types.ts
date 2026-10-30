import type { TFile } from "obsidian";

export const STUDY_AREA = "Учёба";

export const MATERIAL_TYPES = [
  "Термин",
  "Алгоритм",
  "Заметка",
  "Источник",
  "Расчёт",
  "Рисунок",
  "Схема",
  "Таблица",
  "Конспект",
];

export const PRESET_WORK_TYPES = [
  "Проект",
  "Лабораторная работа",
  "Конференция",
  "Диссертация",
  "Курсовая работа",
  "Статья",
  "Экзамен",
  "Зачёт",
  "Практика",
];

export const DONE_STATUSES = [
  "завершён",
  "завершена",
  "сдана",
  "сдан",
  "готово",
  "архив",
  "отменён",
  "отменена",
];

export const TYPE_COLORS: Record<string, string> = {
  Термин: "#4fb3d9",
  Алгоритм: "#9c83e8",
  Заметка: "#4aab80",
  Источник: "#d4c05a",
  Расчёт: "#e06c75",
  Рисунок: "#69b5aa",
  Схема: "#d69852",
  Таблица: "#5c8df6",
  Конспект: "#8bac5e",
};

export interface ProjectCompileConfig {
  includeRootBody: boolean;
  numberSections: boolean;
  stripLeadingH1: boolean;
  groupTermsIntoGlossary: boolean;
  buildBibliography: boolean;
  replaceSourceLinksWithNumbers: boolean;
  autoNumberFiguresAndTables: boolean;
  orderedPaths: string[];
  excludedPaths: string[];
}

export const DEFAULT_COMPILE_CONFIG: ProjectCompileConfig = {
  includeRootBody: true,
  numberSections: true,
  stripLeadingH1: true,
  groupTermsIntoGlossary: true,
  buildBibliography: true,
  replaceSourceLinksWithNumbers: true,
  autoNumberFiguresAndTables: true,
  orderedPaths: [],
  excludedPaths: [],
};

export interface StudyCompilerSettings {
  studyAreaName: string;
  outputFolder: string;
  decksFolder: string;
  templatePrefix: string;
  showCompletedWorks: boolean;
  projectConfigs: Record<string, ProjectCompileConfig>;
}

export const DEFAULT_SETTINGS: StudyCompilerSettings = {
  studyAreaName: "Учёба",
  outputFolder: "Знания/Сборки",
  decksFolder: "Знания/Карточки",
  templatePrefix: "Учёба — ",
  showCompletedWorks: false,
  projectConfigs: {},
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
  deadlineISO: string | null;
  sourceProp: string;
  customIcon: string;
  parentPaths: string[];
  isWork: boolean;
  isActiveWork: boolean;
}

export interface HierarchyNode {
  item: StudyNoteItem;
  depth: number;
  parentPath: string;
  sectionNumber: string;
  included: boolean;
  wordCount: number;
  charCount: number;
  formulaCount: number;
  bodyText: string;
}

export interface ProjectAuditReport {
  totalNodes: number;
  includedNodes: number;
  totalWords: number;
  totalCharsWithSpaces: number;
  authorSheets: string;
  approxPages: number;
  totalFormulas: number;
  totalTables: number;
  totalFigures: number;
  sourcesTotal: StudyNoteItem[];
  sourcesCited: StudyNoteItem[];
  sourcesUncited: StudyNoteItem[];
  visualsTotal: StudyNoteItem[];
  visualsReferenced: StudyNoteItem[];
  visualsUnreferenced: StudyNoteItem[];
  emptySectionNotes: StudyNoteItem[];
}

export interface CompilationResult {
  markdown: string;
  outputFilePath: string;
  audit: ProjectAuditReport;
}