import { App, TFile } from "obsidian";
import {
  DEFAULT_COMPILE_CONFIG,
  DONE_STATUSES,
  HierarchyNode,
  MATERIAL_TYPES,
  PRESET_WORK_TYPES,
  ProjectCompileConfig,
  StudyCompilerSettings,
  StudyNoteItem,
  WorkMetaBadge,
} from "./types";

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
    for (const item of val) {
      res.push(...flattenFrontmatterValue(item));
    }
    return res;
  }
  if (typeof val === "object" && (val as { path?: unknown }).path) {
    return [String((val as { path: unknown }).path).trim()];
  }
  const s = String(val).trim();
  return s ? [s] : [];
}

export function resolveParentPaths(
  app: App,
  file: TFile,
  rawParentProp: unknown
): string[] {
  const rawList = flattenFrontmatterValue(rawParentProp);
  const resolved: string[] = [];

  for (const raw of rawList) {
    const clean = stripOuterWikiBrackets(raw)
      .split("|")[0]
      ?.split("#")[0]
      ?.trim();
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

export function getWorkMeta(typeStr: string, customIcon?: string): WorkMetaBadge {
  const raw = String(typeStr || "Проект").trim();
  const low = raw.toLowerCase();
  let icon = "📁";
  let color = "#599ed6";
  const shortLabel = raw === "Лабораторная работа" ? "Лабораторная" : raw;

  if (
    low.includes("лаб") ||
    low.includes("лр") ||
    low.includes("опыт") ||
    low.includes("эксперим")
  ) {
    icon = "🧪";
    color = "#4aab80";
  } else if (
    low.includes("конф") ||
    low.includes("доклад") ||
    low.includes("выступ") ||
    low.includes("семинар")
  ) {
    icon = "🎤";
    color = "#e06c75";
  } else if (
    low.includes("диплом") ||
    low.includes("диссер") ||
    low.includes("магист") ||
    low.includes("вкр")
  ) {
    icon = "🎓";
    color = "#e5a158";
  } else if (
    low.includes("стать") ||
    low.includes("публик") ||
    low.includes("тезис") ||
    low.includes("нир")
  ) {
    icon = "📄";
    color = "#9c83e8";
  } else if (
    low.includes("курс") ||
    low.includes("рефер") ||
    low.includes("чертеж") ||
    low.includes("расчетно")
  ) {
    icon = "📐";
    color = "#d69852";
  } else if (
    low.includes("экзам") ||
    low.includes("зачет") ||
    low.includes("зачёт") ||
    low.includes("коллок") ||
    low.includes("тест")
  ) {
    icon = "⚡";
    color = "#e5a158";
  } else if (low.includes("практ") || low.includes("стажир")) {
    icon = "🔬";
    color = "#69b5aa";
  }

  if (customIcon && String(customIcon).trim()) {
    icon = String(customIcon).trim();
  }

  return { icon, color, label: `${icon} ${shortLabel}` };
}

export function stripYamlFrontmatter(rawContent: string): string {
  const text = String(rawContent ?? "");
  if (!text.startsWith("---")) return text.trim();
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match || !match[0]) return text.trim();
  return text.slice(match[0].length).trim();
}

export function stripDataviewCodeblocks(body: string): string {
  return body
    .replace(/```(?:dataviewjs|dataview|my-hub|my-study)[\s\S]*?```/gi, "")
    .trim();
}

export function countWordsAndFormulas(cleanBody: string): {
  words: number;
  chars: number;
  formulas: number;
} {
  const trimmed = cleanBody.trim();
  if (!trimmed) return { words: 0, chars: 0, formulas: 0 };

  const blockFormulas = (trimmed.match(/\$\$[\s\S]*?\$\$/g) ?? []).length;
  const withoutBlock = trimmed.replace(/\$\$[\s\S]*?\$\$/g, " ");
  const inlineFormulas = (withoutBlock.match(/\$[^\s$][^$\n]*?\$/g) ?? []).length;

  const plain = trimmed
    .replace(/!\[\[[^\]]+\]\]/g, " ")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/[#*_`~>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = plain ? plain.split(" ").filter(Boolean).length : 0;
  return {
    words,
    chars: plain.length,
    formulas: blockFormulas + inlineFormulas,
  };
}

export function scanStudyVault(
  app: App,
  settings: StudyCompilerSettings
): {
  works: StudyNoteItem[];
  byPath: Map<string, StudyNoteItem>;
  childrenOf: Map<string, string[]>;
} {
  const areaTarget = (settings.studyAreaName || "Учёба").trim();
  const decksPrefix =
    (settings.decksFolder || "Знания/Карточки").replace(/\/+$/, "") + "/";
  const outPrefix =
    (settings.outputFolder || "Знания/Сборки").replace(/\/+$/, "") + "/";
  const tplPrefix = settings.templatePrefix || "Учёба — ";

  const byPath = new Map<string, StudyNoteItem>();
  const childrenOf = new Map<string, string[]>();

  for (const file of app.vault.getMarkdownFiles()) {
    if (
      file.basename.startsWith(tplPrefix) ||
      file.path.startsWith("Шаблоны/") ||
      file.path.startsWith("Templates/") ||
      file.path.startsWith(decksPrefix) ||
      file.path.startsWith(outPrefix)
    ) {
      continue;
    }

    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;

    const areaList = flattenFrontmatterValue(fm["направление"]);
    if (!areaList.includes(areaTarget)) continue;

    const isCardDeck =
      Boolean(fm["колода_карточек"]) ||
      String(fm["подтип"] ?? "").trim().toLowerCase() === "карточки";
    if (isCardDeck) continue;

    const noteType = String(fm["тип"] ?? "").trim();
    const status = String(fm["статус"] ?? "").trim();
    const discipline = String(fm["дисциплина"] ?? "").trim();
    const sourceProp = String(fm["источник"] ?? "").trim();
    const customIcon = String(fm["иконка"] ?? "").trim();
    const rawDeadline = fm["срок"] ? String(fm["срок"]).slice(0, 10) : null;
    const parentPaths = resolveParentPaths(app, file, fm["родитель"]);

    const isWork =
      Boolean(noteType) &&
      !MATERIAL_TYPES.includes(noteType) &&
      parentPaths.length === 0 &&
      (PRESET_WORK_TYPES.includes(noteType) || fm["статус"] !== undefined);

    const isActiveWork =
      isWork && !DONE_STATUSES.includes(status.toLowerCase());

    const item: StudyNoteItem = {
      file,
      path: file.path,
      name: file.basename,
      noteType: noteType || "Заметка",
      status,
      discipline,
      deadlineISO: rawDeadline,
      sourceProp,
      customIcon,
      parentPaths,
      isWork,
      isActiveWork,
    };

    byPath.set(file.path, item);

    for (const pPath of parentPaths) {
      const list = childrenOf.get(pPath) ?? [];
      if (!list.includes(file.path)) {
        list.push(file.path);
        childrenOf.set(pPath, list);
      }
    }
  }

  const works = [...byPath.values()]
    .filter((it) =>
      settings.showCompletedWorks ? it.isWork : it.isActiveWork
    )
    .sort((a, b) => {
      if (a.isActiveWork !== b.isActiveWork) return a.isActiveWork ? -1 : 1;
      const dA = a.deadlineISO ?? "9999-99-99";
      const dB = b.deadlineISO ?? "9999-99-99";
      return dA.localeCompare(dB) || a.name.localeCompare(b.name, "ru");
    });

  return { works, byPath, childrenOf };
}

export async function buildProjectHierarchy(
  app: App,
  rootWork: StudyNoteItem,
  byPath: Map<string, StudyNoteItem>,
  childrenOf: Map<string, string[]>,
  config: ProjectCompileConfig
): Promise<{
  rootBodyText: string;
  rootWords: number;
  nodes: HierarchyNode[];
}> {
  const cfg = { ...DEFAULT_COMPILE_CONFIG, ...config };
  const orderIndexMap = new Map<string, number>();
  cfg.orderedPaths.forEach((p, idx) => orderIndexMap.set(p, idx));
  const excludedSet = new Set(cfg.excludedPaths);

  const visited = new Set<string>([rootWork.path]);
  const rawNodes: Array<{
    item: StudyNoteItem;
    depth: number;
    parentPath: string;
  }> = [];

  const typePriority = (t: string): number => {
    if (t === "Конспект" || t === "Заметка") return 1;
    if (t === "Алгоритм" || t === "Расчёт") return 2;
    if (t === "Таблица" || t === "Рисунок" || t === "Схема") return 3;
    if (t === "Термин") return 4;
    if (t === "Источник") return 5;
    return 2;
  };

  const walk = (currentPath: string, depth: number) => {
    const kids = (childrenOf.get(currentPath) ?? [])
      .map((kPath) => byPath.get(kPath))
      .filter((k): k is StudyNoteItem => Boolean(k && !k.isWork));

    kids.sort((a, b) => {
      const idxA = orderIndexMap.get(a.path);
      const idxB = orderIndexMap.get(b.path);
      if (idxA !== undefined && idxB !== undefined) return idxA - idxB;
      if (idxA !== undefined) return -1;
      if (idxB !== undefined) return 1;
      const pDiff = typePriority(a.noteType) - typePriority(b.noteType);
      if (pDiff !== 0) return pDiff;
      return a.name.localeCompare(b.name, "ru");
    });

    for (const kid of kids) {
      if (visited.has(kid.path)) continue;
      visited.add(kid.path);
      rawNodes.push({ item: kid, depth, parentPath: currentPath });
      walk(kid.path, depth + 1);
    }
  };

  walk(rootWork.path, 0);

  let rootBodyText = "";
  try {
    const rawRoot = await app.vault.cachedRead(rootWork.file);
    rootBodyText = stripDataviewCodeblocks(stripYamlFrontmatter(rawRoot));
  } catch {
    rootBodyText = "";
  }
  const rootStats = countWordsAndFormulas(rootBodyText);

  const counters: number[] = [];
  const nodes: HierarchyNode[] = [];

  for (const rn of rawNodes) {
    let bodyText = "";
    try {
      const raw = await app.vault.cachedRead(rn.item.file);
      bodyText = stripDataviewCodeblocks(stripYamlFrontmatter(raw));
    } catch {
      bodyText = "";
    }

    const included = !excludedSet.has(rn.item.path);
    const isSpecialBottom =
      (cfg.buildBibliography && rn.item.noteType === "Источник") ||
      (cfg.groupTermsIntoGlossary && rn.item.noteType === "Термин");

    let sectionNumber = "—";
    if (included && !isSpecialBottom) {
      const d = rn.depth;
      while (counters.length <= d) counters.push(0);
      counters.splice(d + 1);
      counters[d] = (counters[d] ?? 0) + 1;
      sectionNumber = counters.join(".");
    }

    const st = countWordsAndFormulas(bodyText);
    nodes.push({
      item: rn.item,
      depth: rn.depth,
      parentPath: rn.parentPath,
      sectionNumber,
      included,
      wordCount: st.words,
      charCount: st.chars,
      formulaCount: st.formulas,
      bodyText,
    });
  }

  return {
    rootBodyText,
    rootWords: rootStats.words,
    nodes,
  };
}