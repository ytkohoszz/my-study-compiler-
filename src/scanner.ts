import { App, TFile, getAllTags, normalizePath } from "obsidian";
import {
  DONE_STATUSES,
  DeadlineTone,
  KEYS,
  MATERIAL_TYPES,
  QuickFilterMode,
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

export function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function daysUntilISO(iso: string, baseIso = todayISO()): number {
  const [y1, m1, d1] = iso.split("-").map(Number);
  const [y0, m0, d0] = baseIso.split("-").map(Number);
  if (!y1 || !m1 || !d1 || !y0 || !m0 || !d0) return 999;
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t0 = Date.UTC(y0, m0 - 1, d0);
  return Math.round((t1 - t0) / 86_400_000);
}

export function getDeadlineTone(item: StudyNoteItem, nowIso = todayISO()): DeadlineTone {
  if (!item.deadline || item.isDone) return "none";
  const diff = daysUntilISO(item.deadline, nowIso);
  if (diff < 0) return "overdue";
  if (diff <= 3) return "soon";
  return "far";
}

export function formatDeadlineBadge(item: StudyNoteItem, nowIso = todayISO()): string {
  if (!item.deadline) return "";
  const shortDate = `${item.deadline.slice(8, 10)}.${item.deadline.slice(5, 7)}`;
  if (item.isDone) return shortDate;
  const diff = daysUntilISO(item.deadline, nowIso);
  if (diff < 0) return `${shortDate} (${diff} дн.)`;
  if (diff === 0) return `${shortDate} (сегодня)`;
  if (diff <= 3) return `${shortDate} (${diff} дн.)`;
  return shortDate;
}

export function scanStudyVault(
  app: App,
  settings: StudyCompilerSettings
): ScanResult {
  const byPath = new Map<string, StudyNoteItem>();
  const excluded = settings.excludedFolders
    .map((f) => f.trim().replace(/^\/+|\/+$/g, ""))
    .filter((f) => f.length > 0);

  for (const file of app.vault.getMarkdownFiles()) {
    if (excluded.some((f) => file.path.startsWith(`${f}/`))) continue;
    const cache = app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!fm) continue;
    if (!flattenFrontmatterValue(fm[KEYS.area]).includes(settings.studyAreaName)) {
      continue;
    }

    const status = readString(fm[KEYS.status]);
    const rawDeadline = (
      readString(fm[KEYS.deadline]) || readString(fm[KEYS.deadlineAlt])
    ).slice(0, 10);
    const rawTags = cache ? getAllTags(cache) ?? [] : [];
    const tags = rawTags.map((t) => t.replace(/^#/, "").toLowerCase());

    byPath.set(file.path, {
      file,
      path: file.path,
      name: file.basename,
      noteType: readString(fm[KEYS.type]),
      status,
      discipline: readString(fm[KEYS.discipline]),
      deadline: /^\d{4}-\d{2}-\d{2}$/.test(rawDeadline) ? rawDeadline : null,
      icon: readString(fm[KEYS.icon]),
      tags,
      parentPaths: resolveParentPaths(app, file, fm[KEYS.parent]),
      isDone: DONE_STATUSES.includes(status.toLowerCase()),
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

export function progressOf(
  paths: Iterable<string>,
  scan: ScanResult
): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const p of paths) {
    const it = scan.byPath.get(p);
    if (!it || MATERIAL_TYPES.includes(it.noteType)) continue;
    total++;
    if (it.isDone) done++;
  }
  return { done, total };
}

function matchesFilter(
  item: StudyNoteItem,
  filter: TreeFilterOptions,
  nowIso: string
): boolean {
  if (filter.typeFilter && item.noteType !== filter.typeFilter) return false;

  const tone = getDeadlineTone(item, nowIso);
  const mode: QuickFilterMode = filter.mode;
  if (mode === "active" && (item.isDone || MATERIAL_TYPES.includes(item.noteType))) {
    return false;
  }
  if (mode === "done" && !item.isDone) return false;
  if (mode === "burning" && tone !== "soon" && tone !== "overdue") return false;
  if (mode === "overdue" && tone !== "overdue") return false;
  if (mode === "materials" && !MATERIAL_TYPES.includes(item.noteType)) return false;

  const q = filter.query.trim().toLowerCase();
  if (!q) return true;

  const tokens = q.split(/\s+/).filter(Boolean);
  const haystack = [
    item.name,
    item.noteType,
    item.status,
    item.discipline,
    ...item.tags.map((t) => `#${t}`),
  ]
    .join(" ")
    .toLowerCase();

  return tokens.every((tok) => haystack.includes(tok));
}

/**
 * Строит дерево от выбранного корня (или подветки).
 * Если задан поиск или фильтр, автоматически раскрывает ветки, ведущие к совпадениям.
 */
export function buildFilteredTree(
  branchRoot: StudyNoteItem,
  scan: ScanResult,
  expanded: Set<string> | null,
  filter: TreeFilterOptions
): TreeNode[] {
  const nowIso = todayISO();

  if (filter.mode === "orphans") {
    return scan.orphans
      .filter((it) => matchesFilter(it, { ...filter, mode: "all" }, nowIso))
      .map((item) => ({
        item,
        depth: 0,
        hasChildren: false,
        done: 0,
        total: 0,
        isDirectMatch: true,
      }));
  }

  const isFiltering =
    filter.query.trim().length > 0 ||
    filter.mode !== "all" ||
    filter.typeFilter.length > 0;

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
        const selfMatch = matchesFilter(kid, filter, nowIso);
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

  const out: TreeNode[] = [];
  const walk = (path: string, depth: number, trail: Set<string>) => {
    const kids = (scan.childrenOf.get(path) ?? [])
      .map((p) => scan.byPath.get(p))
      .filter((x): x is StudyNoteItem => x !== undefined)
      .sort(byName);

    for (const kid of kids) {
      if (trail.has(kid.path)) continue;
      if (isFiltering && !visibleBranchPaths.has(kid.path)) continue;

      const allKids = scan.childrenOf.get(kid.path) ?? [];
      const hasChildren = isFiltering
        ? allKids.some((k) => visibleBranchPaths.has(k))
        : allKids.length > 0;
      const stats = progressOf(collectDescendants(kid.path, scan), scan);

      out.push({
        item: kid,
        depth,
        hasChildren,
        done: stats.done,
        total: stats.total,
        isDirectMatch: isFiltering ? directMatches.has(kid.path) : false,
      });

      const shouldExpand =
        isFiltering || expanded === null || expanded.has(kid.path);
      if (hasChildren && shouldExpand) {
        trail.add(kid.path);
        walk(kid.path, depth + 1, trail);
        trail.delete(kid.path);
      }
    }
  };

  walk(branchRoot.path, 0, new Set([branchRoot.path]));
  return out;
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