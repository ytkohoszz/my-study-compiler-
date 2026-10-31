import { App, TFile, getAllTags, normalizePath } from "obsidian";
import {
  CustomPropValueKind,
  DeadlineTone,
  KEYS,
  LEGACY_MATERIAL_TYPES,
  RESERVED_YAML_KEYS,
  ROOT_DONE_STATUSES,
  StudyCompilerSettings,
  StudyNoteItem,
  TreeFilterOptions,
  TreeNode,
  TypeSuggestion,
  VaultPropertySchema,
  WorkMetaBadge,
} from "./types";

export interface ScanResult {
  roots: StudyNoteItem[];
  activeRoots: StudyNoteItem[];
  completedRoots: StudyNoteItem[];
  orphans: StudyNoteItem[];
  byPath: Map<string, StudyNoteItem>;
  childrenOf: Map<string, string[]>;
  schema: VaultPropertySchema;
}

export function emptyScan(): ScanResult {
  return {
    roots: [],
    activeRoots: [],
    completedRoots: [],
    orphans: [],
    byPath: new Map(),
    childrenOf: new Map(),
    schema: { typeCounts: [], propertyKeys: [], valuesByKey: new Map() },
  };
}

export function byName(a: StudyNoteItem, b: StudyNoteItem): number {
  return a.name.localeCompare(b.name, "ru", { numeric: true });
}

export function sortActiveRoots(a: StudyNoteItem, b: StudyNoteItem): number {
  const dA = a.deadline ?? "9999-99-99";
  const dB = b.deadline ?? "9999-99-99";
  if (dA !== dB) return dA.localeCompare(dB);
  return byName(a, b);
}

export function sortCompletedRoots(a: StudyNoteItem, b: StudyNoteItem): number {
  if (a.finishedAt && b.finishedAt && a.finishedAt !== b.finishedAt) {
    return b.finishedAt.localeCompare(a.finishedAt);
  }
  return byName(a, b);
}

export function normalizeSpaces(s: string): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function stripOuterWikiBrackets(str: string): string {
  let s = String(str || "").trim();
  if (s.startsWith("[[")) s = s.slice(2);
  if (s.endsWith("]]")) s = s.slice(0, -2);
  return s;
}

export function flattenFrontmatterValue(val: unknown): string[] {
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

export function isRootStatusCompleted(status: string): boolean {
  const clean = normalizeSpaces(status).toLowerCase();
  if (!clean) return false;
  return ROOT_DONE_STATUSES.includes(clean);
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
  if (!item.deadline || item.isCompletedRoot) return "none";
  const diff = daysUntilISO(item.deadline);
  if (diff < 0) return "overdue";
  if (diff <= 7) return "soon";
  return "far";
}

export function formatDeadlineBadge(item: StudyNoteItem): string {
  if (!item.deadline) return "";
  if (item.isCompletedRoot) {
    return `${item.deadline.slice(8, 10)}.${item.deadline.slice(5, 7)}.${item.deadline.slice(0, 4)}`;
  }
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
  if (
    fm[KEYS.templateFlag] === true ||
    String(fm[KEYS.templateFlag]).toLowerCase() === "true"
  ) {
    return true;
  }

  return false;
}

const SYSTEM_FM_IGNORE = new Set([
  KEYS.area,
  KEYS.type,
  KEYS.parent,
  "position",
  "tags",
  "tag",
  "aliases",
  "alias",
  "cssclasses",
  "cssclass",
]);

export function scanStudyVault(
  app: App,
  settings: StudyCompilerSettings
): ScanResult {
  const byPath = new Map<string, StudyNoteItem>();
  const typeCounter = new Map<string, { display: string; count: number }>();
  const propKeyFreq = new Map<string, number>();
  const valuesSetByKey = new Map<string, Set<string>>();

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

    const noteType = normalizeSpaces(readString(fm[KEYS.type]));
    if (noteType) {
      const lowerT = noteType.toLowerCase();
      const prev = typeCounter.get(lowerT);
      if (prev) prev.count++;
      else typeCounter.set(lowerT, { display: noteType, count: 1 });
    }

    for (const [k, rawVal] of Object.entries(fm)) {
      if (SYSTEM_FM_IGNORE.has(k)) continue;
      propKeyFreq.set(k, (propKeyFreq.get(k) ?? 0) + 1);
      const flatVals = flattenFrontmatterValue(rawVal);
      if (flatVals.length > 0) {
        let vSet = valuesSetByKey.get(k);
        if (!vSet) {
          vSet = new Set<string>();
          valuesSetByKey.set(k, vSet);
        }
        if (vSet.size < 40) {
          for (const fv of flatVals) {
            if (fv.length <= 80) vSet.add(fv);
          }
        }
      }
    }

    const status = normalizeSpaces(readString(fm[KEYS.status]));
    const rawDeadline = (
      readString(fm[KEYS.deadline]) || readString(fm[KEYS.deadlineAlt])
    ).slice(0, 10);
    const rawFinished = readString(fm[KEYS.finishedAt]).slice(0, 10);

    byPath.set(file.path, {
      file,
      path: file.path,
      name: file.basename,
      noteType,
      status,
      isCompletedRoot: isRootStatusCompleted(status),
      finishedAt: /^\d{4}-\d{2}-\d{2}$/.test(rawFinished) ? rawFinished : null,
      discipline: readString(fm[KEYS.discipline]),
      deadline: /^\d{4}-\d{2}-\d{2}$/.test(rawDeadline) ? rawDeadline : null,
      icon: readString(fm[KEYS.icon]),
      tags,
      parentPaths: resolveParentPaths(app, file, fm[KEYS.parent]),
    });
  }

  const childrenOf = new Map<string, string[]>();

  for (const item of byPath.values()) {
    const parents = item.parentPaths.filter((p) => p !== item.path && byPath.has(p));
    item.parentPaths = parents;
    for (const p of parents) {
      const list = childrenOf.get(p) ?? [];
      if (!list.includes(item.path)) list.push(item.path);
      childrenOf.set(p, list);
    }
  }

  const roots: StudyNoteItem[] = [];
  const orphans: StudyNoteItem[] = [];
  const legacyMaterialsLower = new Set(
    LEGACY_MATERIAL_TYPES.map((t) => t.toLowerCase())
  );

  for (const item of byPath.values()) {
    if (item.parentPaths.length > 0) continue;

    const hasChildren = (childrenOf.get(item.path)?.length ?? 0) > 0;
    const hasRootMarkers = Boolean(item.status || item.deadline);
    const isLegacyLeafMaterial =
      !hasChildren &&
      !hasRootMarkers &&
      legacyMaterialsLower.has(item.noteType.toLowerCase());

    if (isLegacyLeafMaterial) {
      orphans.push(item);
    } else {
      roots.push(item);
    }
  }

  const activeRoots = roots
    .filter((r) => !r.isCompletedRoot)
    .sort(sortActiveRoots);
  const completedRoots = roots
    .filter((r) => r.isCompletedRoot)
    .sort(sortCompletedRoots);
  roots.sort(byName);
  orphans.sort(byName);

  const typeCounts: TypeSuggestion[] = [...typeCounter.values()]
    .map((x) => ({ name: x.display, count: x.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ru"));

  const propertyKeys = [...propKeyFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))
    .map(([k]) => k);

  const valuesByKey = new Map<string, string[]>();
  for (const [k, set] of valuesSetByKey.entries()) {
    valuesByKey.set(
      k,
      [...set].sort((a, b) => a.localeCompare(b, "ru", { numeric: true }))
    );
  }

  return {
    roots,
    activeRoots,
    completedRoots,
    orphans,
    byPath,
    childrenOf,
    schema: { typeCounts, propertyKeys, valuesByKey },
  };
}

export function findCaseInsensitiveTypeMatch(
  input: string,
  suggestions: TypeSuggestion[]
): string | null {
  const clean = normalizeSpaces(input);
  if (!clean) return null;
  const lower = clean.toLowerCase();
  for (const s of suggestions) {
    if (s.name.toLowerCase() === lower && s.name !== clean) {
      return s.name;
    }
  }
  return null;
}

/**
 * Преобразует строковый ввод произвольного свойства в корректный тип для YAML:
 * - пустая строка -> undefined (не записывать)
 * - kind === "list" -> массив строк по запятой
 * - YYYY-MM-DD -> строка (будет записана в кавычках в YAML)
 * - true / false -> boolean
 * - число -> number без кавычек
 */
export function parseCustomPropertyValue(
  rawValue: string,
  kind: CustomPropValueKind
): unknown {
  const trimmed = rawValue.trim();
  if (!trimmed) return undefined;

  if (kind === "list") {
    const items = trimmed
      .split(",")
      .map((x) => normalizeSpaces(x))
      .filter((x) => x.length > 0);
    return items.length > 0 ? items : undefined;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) return num;
  }

  return trimmed;
}

export function serializeYamlScalarOrList(val: unknown): string {
  if (Array.isArray(val)) {
    return `[${val.map((x) => JSON.stringify(String(x))).join(", ")}]`;
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return String(val);
  }
  return JSON.stringify(String(val ?? ""));
}

export function isReservedYamlKey(key: string): boolean {
  const low = normalizeSpaces(key).toLowerCase();
  return RESERVED_YAML_KEYS.some((k) => k.toLowerCase() === low);
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
  if (
    filter.typeFilter &&
    item.noteType.toLowerCase() !== filter.typeFilter.toLowerCase()
  ) {
    return false;
  }

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

const HASH_PALETTE: readonly string[] = [
  "var(--color-blue, #599ed6)",
  "var(--color-green, #4aab80)",
  "var(--color-purple, #9c83e8)",
  "var(--color-orange, #e5a158)",
  "var(--color-cyan, #4fb3d9)",
  "var(--color-pink, #d882b6)",
  "var(--color-yellow, #d4c05a)",
  "var(--color-red, #e06c75)",
];

function pickStableHashColor(str: string): string {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const idx = Math.abs(h) % HASH_PALETTE.length;
  return HASH_PALETTE[idx] ?? "var(--color-blue, #599ed6)";
}

export function getWorkMeta(typeStr: string, customIcon?: string): WorkMetaBadge {
  const raw = normalizeSpaces(typeStr);
  const low = raw.toLowerCase();
  let icon = "📌";
  let color = raw ? pickStableHashColor(low) : "var(--text-muted)";
  const shortLabel = raw === "Лабораторная работа" ? "Лабораторная" : raw || "без типа";

  if (low.includes("лаб") || low.includes("лр") || low.includes("опыт") || low.includes("эксперим")) {
    icon = "🧪";
    color = "var(--color-green, #4aab80)";
  } else if (low.includes("конф") || low.includes("доклад") || low.includes("выступ") || low.includes("семинар")) {
    icon = "🎤";
    color = "var(--color-red, #e06c75)";
  } else if (low.includes("диплом") || low.includes("диссер") || low.includes("магист") || low.includes("вкр")) {
    icon = "🎓";
    color = "var(--color-orange, #e5a158)";
  } else if (low.includes("стать") || low.includes("публик") || low.includes("тезис") || low.includes("нир")) {
    icon = "📄";
    color = "var(--color-purple, #9c83e8)";
  } else if (low.includes("курс") || low.includes("рефер") || low.includes("чертеж")) {
    icon = "📐";
    color = "var(--color-orange, #d69852)";
  } else if (low.includes("экзам") || low.includes("зачет") || low.includes("зачёт") || low.includes("коллок") || low.includes("тест")) {
    icon = "⚡";
    color = "var(--color-orange, #e5a158)";
  } else if (low.includes("практ") || low.includes("стажир")) {
    icon = "🔬";
    color = "var(--color-cyan, #69b5aa)";
  } else if (low.includes("проект")) {
    icon = "📁";
    color = "var(--color-blue, #599ed6)";
  } else if (low.includes("термин")) {
    icon = "🔤";
    color = "var(--color-cyan, #4fb3d9)";
  } else if (low.includes("источник") || low.includes("книг") || low.includes("литерат")) {
    icon = "📚";
    color = "var(--color-yellow, #d4c05a)";
  } else if (low.includes("конспект") || low.includes("лекц")) {
    icon = "📝";
    color = "var(--color-green, #8bac5e)";
  } else if (low.includes("рисунок") || low.includes("схема") || low.includes("граф")) {
    icon = "🖼";
    color = "var(--color-cyan, #69b5aa)";
  } else if (low.includes("таблица")) {
    icon = "📊";
    color = "var(--color-blue, #5c8df6)";
  } else if (low.includes("расчёт") || low.includes("расчет") || low.includes("формул")) {
    icon = "🧮";
    color = "var(--color-red, #e06c75)";
  } else if (low.includes("алгоритм") || low.includes("метод")) {
    icon = "⚙️";
    color = "var(--color-purple, #9c83e8)";
  }

  if (customIcon && String(customIcon).trim()) {
    icon = String(customIcon).trim();
  }
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