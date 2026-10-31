import { App, TFile, getAllTags, normalizePath } from "obsidian";
import {
  DeadlineTone,
  KEYS,
  MATERIAL_TYPES,
  StudyCompilerSettings,
  StudyNoteItem,
  TreeFilterOptions,
  TreeNode,
  WorkMetaBadge,
} from "./types";

export interface ScanResult {
  roots: StudyNoteItem[];
  orphans: StudyNoteItem[];
  byPath: Map<string, StudyNoteItem>;
  childrenOf: Map<string, string[]>;
}

export function emptyScan(): ScanResult {
  return { roots: [], orphans: [], byPath: new Map(), childrenOf: new Map() };
}

export function byName(a: StudyNoteItem, b: StudyNoteItem): number {
  return a.name.localeCompare(b.name, "ru", { numeric: true });
}

function stripOuterWikiBrackets(str: string): string {
  let s = String(str || "").trim();
  if (s.startsWith("[[")) s = s.slice(2);
  if (s.endsWith("]]")) s = s.slice(0, -2);
  return s;
}

function flattenFrontmatterValue(val: unknown): string[] {
  if (val === null || val === undefined) return [];
  if (Array.isArray(val)) {
    const res: string[] = [];
    for (const item of val) res.push(...flattenFrontmatterValue(item));
    return res;
  }
  if (typeof val === "object" && (val as { path?: unknown }).path) {
    return [String((val as { path: unknown }).path).trim()];
  }
  const s = String(val).trim();
  return s ? [s] : [];
}

function readString(v: unknown): string {
  return v === null || v === undefined ? "" : String(v).trim();
}

export function resolveParentPaths(
  app: App,
  file: TFile,
  rawParentProp: unknown
): string[] {
  const resolved: string[] = [];
  for (const raw of flattenFrontmatterValue(rawParentProp)) {
    const clean = stripOuterWikiBrackets(raw).split("|")[0]?.split("#")[0]?.trim();
    if (!clean) continue;

    const direct = app.vault.getAbstractFileByPath(clean);
    if (direct instanceof TFile) {
      if (!resolved.includes(direct.path)) resolved.push(direct.path);
      continue;
    }
    const withMd = app.vault.getAbstractFileByPath(
      clean.endsWith(".md") ? clean : `${clean}.md`
    );
    if (withMd instanceof TFile) {
      if (!resolved.includes(withMd.path)) resolved.push(withMd.path);
      continue;
    }
    const dest = app.metadataCache.getFirstLinkpathDest(clean, file.path);
    if (dest instanceof TFile && !resolved.includes(dest.path)) {
      resolved.push(dest.path);
    }
  }
  return resolved;
}

/** Текущая календарная дата в местном часовом поясе (ГГГГ-ММ-ДД). */
export function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Разница в календарных днях по местному времени без смещений из-за времени суток или часовых поясов.
 */
export function daysUntilISO(iso: string): number {
  const parts = iso.split("-").map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (!y || !m || !d) return 999;

  const now = new Date();
  const todayLocalMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );
  const targetLocalMidnight = new Date(y, m - 1, d);
  return Math.round(
    (targetLocalMidnight.getTime() - todayLocalMidnight.getTime()) / 86_400_000
  );
}

/** Русское склонение числительных: 1 день, 2 дня, 5 дней. */
export function pluralizeDays(n: number): string {
  const abs = Math.abs(Math.trunc(n));
  const mod100 = abs % 100;
  const mod10 = abs % 10;
  if (mod100 >= 11 && mod100 <= 19) return `${abs} дней`;
  if (mod10 === 1) return `${abs} день`;
  if (mod10 >= 2 && mod10 <= 4) return `${abs} дня`;
  return `${abs} дней`;
}

export function getDeadlineTone(item: StudyNoteItem): DeadlineTone {
  if (!item.deadline) return "none";
  const diff = daysUntilISO(item.deadline);
  if (diff < 0) return "overdue";
  if (diff <= 7) return "soon";
  return "far";
}

export function formatDeadlineBadge(item: StudyNoteItem): string {
  if (!item.deadline) return "";
  const diff = daysUntilISO(item.deadline);
  if (diff === 0) return "сегодня";
  if (diff === 1) return "завтра";
  if (diff > 1) return `осталось ${pluralizeDays(diff)}`;
  if (diff === -1) return "просрочено на 1 день";
  return `просрочено на ${pluralizeDays(Math.abs(diff))}`;
}

export function formatFullDateTooltip(iso: string): string {
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  return `Дедлайн: ${parts[2]}.${parts[1]}.${parts[0]}`;
}

function isTemplateOrExcludedFile(
  file: TFile,
  fm: Record<string, unknown>,
  tagsLower: string[],
  settings: StudyCompilerSettings
): boolean {
  const excludedFolders = settings.excludedFolders
    .map((f) => f.trim().replace(/^\/+|\/+$/g, "").toLowerCase())
    .filter((f) => f.length > 0);

  const pathLower = file.path.toLowerCase();
  const folderSegments = pathLower.split("/").slice(0, -1);
  for (const exFolder of excludedFolders) {
    if (
      pathLower.startsWith(`${exFolder}/`) ||
      folderSegments.includes(exFolder)
    ) {
      return true;
    }
  }

  const prefixes = settings.excludedTitlePrefixes
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  const baseLower = file.basename.toLowerCase();
  if (prefixes.some((pref) => baseLower.startsWith(pref))) {
    return true;
  }

  const excludedTags = settings.excludedTags
    .map((t) => t.trim().replace(/^#/, "").toLowerCase())
    .filter((t) => t.length > 0);
  if (tagsLower.some((t) => excludedTags.includes(t))) {
    return true;
  }

  const noteTypeLower = readString(fm[KEYS.type]).toLowerCase();
  if (noteTypeLower === "шаблон" || noteTypeLower === "template") {
    return true;
  }
  if (fm[KEYS.templateFlag] === true || String(fm[KEYS.templateFlag]).toLowerCase() === "true") {
    return true;
  }

  return false;
}

export function scanStudyVault(
  app: App,
  settings: StudyCompilerSettings
): ScanResult {
  const byPath = new Map<string, StudyNoteItem>();

  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!fm) continue;

    if (!flattenFrontmatterValue(fm[KEYS.area]).includes(settings.studyAreaName)) {
      continue;
    }

    const isCardDeck =
      Boolean(fm["колода_карточек"]) ||
      readString(fm["подтип"]).toLowerCase() === "карточки";
    if (isCardDeck) continue;

    const rawTags = cache ? getAllTags(cache) ?? [] : [];
    const tags = rawTags.map((t) => t.replace(/^#/, "").toLowerCase());

    if (isTemplateOrExcludedFile(file, fm, tags, settings)) {
      continue;
    }

    const rawDeadline = (
      readString(fm[KEYS.deadline]) || readString(fm[KEYS.deadlineAlt])
    ).slice(0, 10);

    byPath.set(file.path, {
      file,
      path: file.path,
      name: file.basename,
      noteType: readString(fm[KEYS.type]),
      discipline: readString(fm[KEYS.discipline]),
      deadline: /^\d{4}-\d{2}-\d{2}$/.test(rawDeadline) ? rawDeadline : null,
      icon: readString(fm[KEYS.icon]),
      tags,
      parentPaths: resolveParentPaths(app, file, fm[KEYS.parent]),
    });
  }

  const childrenOf = new Map<string, string[]>();
  const roots: StudyNoteItem[] = [];
  const orphans: StudyNoteItem[] = [];

  for (const item of byPath.values()) {
    const parents = item.parentPaths.filter((p) => p !== item.path && byPath.has(p));
    item.parentPaths = parents;
    for (const p of parents) {
      const list = childrenOf.get(p) ?? [];
      if (!list.includes(item.path)) list.push(item.path);
      childrenOf.set(p, list);
    }
    if (parents.length === 0) {
      if (MATERIAL_TYPES.includes(item.noteType)) orphans.push(item);
      else roots.push(item);
    }
  }

  roots.sort(byName);
  orphans.sort(byName);
  return { roots, orphans, byPath, childrenOf };
}

export function findRootPath(scan: ScanResult, path: string): string {
  const seen = new Set<string>();
  let cur = path;
  for (;;) {
    if (seen.has(cur)) return cur;
    seen.add(cur);
    const next = scan.byPath.get(cur)?.parentPaths[0];
    if (!next) return cur;
    cur = next;
  }
}

export function buildBreadcrumbChain(
  scan: ScanResult,
  projectRootPath: string,
  focusPath: string
): StudyNoteItem[] {
  const chain: StudyNoteItem[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = focusPath;

  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const item = scan.byPath.get(cur);
    if (!item) break;
    chain.unshift(item);
    if (cur === projectRootPath) break;
    cur = item.parentPaths[0];
  }

  const rootItem = scan.byPath.get(projectRootPath);
  if (rootItem && chain[0]?.path !== projectRootPath) {
    chain.unshift(rootItem);
  }
  return chain;
}

export function collectDescendants(path: string, scan: ScanResult): Set<string> {
  const result = new Set<string>();
  const stack: string[] = [path];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    for (const kid of scan.childrenOf.get(cur) ?? []) {
      if (kid === path || result.has(kid)) continue;
      result.add(kid);
      stack.push(kid);
    }
  }
  return result;
}

function matchesFilter(item: StudyNoteItem, filter: TreeFilterOptions): boolean {
  if (filter.typeFilter && item.noteType !== filter.typeFilter) return false;

  const q = filter.query.trim().toLowerCase();
  if (!q) return true;

  const tokens = q.split(/\s+/).filter(Boolean);
  const haystack = [
    item.name,
    item.noteType,
    item.discipline,
    ...item.tags.map((t) => `#${t}`),
  ]
    .join(" ")
    .toLowerCase();

  return tokens.every((tok) => haystack.includes(tok));
}

/**
 * Строит иерархическое дерево TreeNode[] с вложенными массивами children,
 * чтобы в интерфейсе отрисовывать наглядные контейнеры веток с направляющими линиями.
 */
export function buildNestedFilteredTree(
  branchRoot: StudyNoteItem,
  scan: ScanResult,
  expanded: Set<string> | null,
  filter: TreeFilterOptions
): TreeNode[] {
  if (filter.mode === "orphans") {
    return scan.orphans
      .filter((it) => matchesFilter(it, { ...filter, mode: "all" }))
      .map((item) => ({
        item,
        depth: 0,
        hasChildren: false,
        isExpanded: false,
        directChildrenCount: 0,
        descendantCount: 0,
        isDirectMatch: true,
        children: [],
      }));
  }

  const isFiltering =
    filter.query.trim().length > 0 || filter.typeFilter.length > 0;

  const directMatches = new Set<string>();
  const visibleBranchPaths = new Set<string>();

  if (isFiltering) {
    const checkSubtree = (path: string, trail: Set<string>): boolean => {
      let anyChildMatched = false;
      for (const kidPath of scan.childrenOf.get(path) ?? []) {
        if (trail.has(kidPath)) continue;
        const kid = scan.byPath.get(kidPath);
        if (!kid) continue;
        trail.add(kidPath);
        const childHas = checkSubtree(kidPath, trail);
        trail.delete(kidPath);
        const selfMatch = matchesFilter(kid, filter);
        if (selfMatch) directMatches.add(kidPath);
        if (selfMatch || childHas) {
          visibleBranchPaths.add(kidPath);
          anyChildMatched = true;
        }
      }
      return anyChildMatched;
    };
    checkSubtree(branchRoot.path, new Set([branchRoot.path]));
  }

  const buildLevel = (
    parentPath: string,
    depth: number,
    trail: Set<string>
  ): TreeNode[] => {
    const kids = (scan.childrenOf.get(parentPath) ?? [])
      .map((p) => scan.byPath.get(p))
      .filter((x): x is StudyNoteItem => x !== undefined)
      .sort(byName);

    const levelNodes: TreeNode[] = [];

    for (const kid of kids) {
      if (trail.has(kid.path)) continue;
      if (isFiltering && !visibleBranchPaths.has(kid.path)) continue;

      const allKidChildren = scan.childrenOf.get(kid.path) ?? [];
      const hasChildren = isFiltering
        ? allKidChildren.some((k) => visibleBranchPaths.has(k))
        : allKidChildren.length > 0;

      const descendants = collectDescendants(kid.path, scan);
      const isExpanded =
        hasChildren &&
        (isFiltering || expanded === null || expanded.has(kid.path));

      let childrenNodes: TreeNode[] = [];
      if (isExpanded) {
        trail.add(kid.path);
        childrenNodes = buildLevel(kid.path, depth + 1, trail);
        trail.delete(kid.path);
      }

      levelNodes.push({
        item: kid,
        depth,
        hasChildren,
        isExpanded,
        directChildrenCount: allKidChildren.length,
        descendantCount: descendants.size,
        isDirectMatch: isFiltering ? directMatches.has(kid.path) : false,
        children: childrenNodes,
      });
    }

    return levelNodes;
  };

  return buildLevel(branchRoot.path, 0, new Set([branchRoot.path]));
}

export function flattenVisibleTree(nodes: TreeNode[]): TreeNode[] {
  const flat: TreeNode[] = [];
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      flat.push(n);
      if (n.isExpanded && n.children.length > 0) {
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return flat;
}

export function getWorkMeta(typeStr: string, customIcon?: string): WorkMetaBadge {
  const raw = String(typeStr || "Проект").trim();
  const low = raw.toLowerCase();
  let icon = "📁";
  let color = "#599ed6";
  const shortLabel = raw === "Лабораторная работа" ? "Лабораторная" : raw;

  if (low.includes("лаб") || low.includes("лр") || low.includes("опыт") || low.includes("эксперим")) {
    icon = "🧪";
    color = "#4aab80";
  } else if (low.includes("конф") || low.includes("доклад") || low.includes("выступ") || low.includes("семинар")) {
    icon = "🎤";
    color = "#e06c75";
  } else if (low.includes("диплом") || low.includes("диссер") || low.includes("магист") || low.includes("вкр")) {
    icon = "🎓";
    color = "#e5a158";
  } else if (low.includes("стать") || low.includes("публик") || low.includes("тезис") || low.includes("нир")) {
    icon = "📄";
    color = "#9c83e8";
  } else if (low.includes("курс") || low.includes("рефер") || low.includes("чертеж") || low.includes("расчетно")) {
    icon = "📐";
    color = "#d69852";
  } else if (low.includes("экзам") || low.includes("зачет") || low.includes("зачёт") || low.includes("коллок") || low.includes("тест")) {
    icon = "⚡";
    color = "#e5a158";
  } else if (low.includes("практ") || low.includes("стажир")) {
    icon = "🔬";
    color = "#69b5aa";
  } else if (low.includes("термин")) {
    icon = "🔤";
    color = "#4fb3d9";
  } else if (low.includes("источник")) {
    icon = "📚";
    color = "#d4c05a";
  } else if (low.includes("конспект")) {
    icon = "📝";
    color = "#8bac5e";
  } else if (low.includes("рисунок") || low.includes("схема")) {
    icon = "🖼";
    color = "#69b5aa";
  } else if (low.includes("таблица")) {
    icon = "📊";
    color = "#5c8df6";
  } else if (low.includes("расчёт") || low.includes("расчет")) {
    icon = "🧮";
    color = "#e06c75";
  }

  if (customIcon && String(customIcon).trim()) icon = String(customIcon).trim();
  return { icon, color, label: `${icon} ${shortLabel}` };
}

export async function ensureFolder(app: App, folderPath: string): Promise<void> {
  let current = "";
  for (const part of normalizePath(folderPath).split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      try {
        await app.vault.createFolder(current);
      } catch {
        // папка уже создана параллельно
      }
    }
  }
}