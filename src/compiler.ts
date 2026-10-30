import { App, TFile, normalizePath } from "obsidian";
import {
  CompilationResult,
  HierarchyNode,
  ProjectAuditReport,
  ProjectCompileConfig,
  StudyNoteItem,
} from "./types";
import { countWordsAndFormulas } from "./scanner";

function removeLeadingHeadingIfMatches(body: string, noteTitle: string): string {
  const lines = body.split(/\r?\n/);
  let firstNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").trim().length > 0) {
      firstNonEmpty = i;
      break;
    }
  }
  if (firstNonEmpty === -1) return "";

  const firstLine = (lines[firstNonEmpty] ?? "").trim();
  if (firstLine.startsWith("#")) {
    const cleanHeading = firstLine.replace(/^#+\s*/, "").trim().toLowerCase();
    const cleanTitle = noteTitle.trim().toLowerCase();
    if (cleanHeading === cleanTitle || firstLine.startsWith("# ")) {
      lines.splice(firstNonEmpty, 1);
      return lines.join("\n").trim();
    }
  }
  return body.trim();
}

function adjustInternalHeadings(body: string, baseHashesCount: number): string {
  const shift = Math.max(0, baseHashesCount - 1);
  if (shift <= 0) return body;

  let inCodeBlock = false;
  return body
    .split(/\r?\n/)
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        return line;
      }
      if (inCodeBlock) return line;
      const m = line.match(/^(#{1,6})(\s+.*)$/);
      if (!m || !m[1] || !m[2]) return line;
      const nextCount = Math.min(6, m[1].length + shift);
      return "#".repeat(nextCount) + m[2];
    })
    .join("\n");
}

function extractWikiLinksFromText(text: string): string[] {
  const results: string[] = [];
  const regex = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const rawTarget = (m[1] ?? "").trim();
    if (rawTarget) results.push(rawTarget);
  }
  return results;
}

function formatBibliographyEntry(sourceNote: StudyNoteItem, body: string): string {
  const firstParagraph = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));

  if (firstParagraph) {
    const clean = firstParagraph.replace(/^[-*+]\s+/, "").trim();
    if (clean.length >= 10) {
      return clean;
    }
  }
  if (sourceNote.sourceProp) {
    return `${sourceNote.name} — ${sourceNote.sourceProp}`;
  }
  return sourceNote.name;
}

export function buildAuditAndCompileProject(
  rootWork: StudyNoteItem,
  rootBodyText: string,
  nodes: HierarchyNode[],
  config: ProjectCompileConfig,
  outputFolder: string
): CompilationResult {
  const includedNodes = nodes.filter((n) => n.included);

  // Собираем весь текст включённых разделов (кроме самих карточек источников) для проверки цитирований
  const narrativeChunks: string[] = [];
  if (config.includeRootBody && rootBodyText) {
    narrativeChunks.push(rootBodyText);
  }
  for (const n of includedNodes) {
    if (n.item.noteType !== "Источник") {
      narrativeChunks.push(n.bodyText);
    }
  }
  const combinedNarrative = narrativeChunks.join("\n\n");
  const allLinkedTargetsLower = new Set(
    extractWikiLinksFromText(combinedNarrative).map((s) =>
      s.replace(/\.md$/i, "").toLowerCase()
    )
  );

  const isNoteReferencedInNarrative = (item: StudyNoteItem): boolean => {
    const nameLower = item.name.toLowerCase();
    const pathLower = item.path.replace(/\.md$/i, "").toLowerCase();
    return (
      allLinkedTargetsLower.has(nameLower) ||
      allLinkedTargetsLower.has(pathLower)
    );
  };

  const sourcesTotal = includedNodes
    .filter((n) => n.item.noteType === "Источник")
    .map((n) => n.item);
  const sourcesCited = sourcesTotal.filter(isNoteReferencedInNarrative);
  const sourcesUncited = sourcesTotal.filter(
    (s) => !isNoteReferencedInNarrative(s)
  );

  const visualsTotal = includedNodes
    .filter((n) =>
      ["Рисунок", "Схема", "Таблица"].includes(n.item.noteType)
    )
    .map((n) => n.item);
  const visualsReferenced = visualsTotal.filter(isNoteReferencedInNarrative);
  const visualsUnreferenced = visualsTotal.filter(
    (v) => !isNoteReferencedInNarrative(v)
  );

  const emptySectionNotes = includedNodes
    .filter(
      (n) =>
        n.item.noteType !== "Источник" &&
        n.item.noteType !== "Рисунок" &&
        n.item.noteType !== "Схема" &&
        n.wordCount < 5
    )
    .map((n) => n.item);

  // Сквозная нумерация источников в порядке первого упоминания (затем остальные привязанные источники)
  const sourceNumberMap = new Map<string, number>();
  const orderedSourcesForBib: HierarchyNode[] = [];
  const sourceNodes = includedNodes.filter(
    (n) => n.item.noteType === "Источник"
  );
  const sourceByLowerName = new Map<string, HierarchyNode>();
  for (const sn of sourceNodes) {
    sourceByLowerName.set(sn.item.name.toLowerCase(), sn);
    sourceByLowerName.set(sn.item.path.replace(/\.md$/i, "").toLowerCase(), sn);
  }

  for (const linkTarget of extractWikiLinksFromText(combinedNarrative)) {
    const key = linkTarget.replace(/\.md$/i, "").toLowerCase();
    const matchedSource = sourceByLowerName.get(key);
    if (matchedSource && !sourceNumberMap.has(matchedSource.item.path)) {
      const nextNum = orderedSourcesForBib.length + 1;
      sourceNumberMap.set(matchedSource.item.path, nextNum);
      orderedSourcesForBib.push(matchedSource);
    }
  }
  for (const sn of sourceNodes) {
    if (!sourceNumberMap.has(sn.item.path)) {
      const nextNum = orderedSourcesForBib.length + 1;
      sourceNumberMap.set(sn.item.path, nextNum);
      orderedSourcesForBib.push(sn);
    }
  }

  const replaceCitationsInText = (text: string): string => {
    if (!config.replaceSourceLinksWithNumbers || sourceNumberMap.size === 0) {
      return text;
    }
    return text.replace(
      /(?<!!)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g,
      (fullMatch, rawTarget: string) => {
        const key = String(rawTarget ?? "")
          .trim()
          .replace(/\.md$/i, "")
          .toLowerCase();
        const found = sourceByLowerName.get(key);
        if (!found) return fullMatch;
        const num = sourceNumberMap.get(found.item.path);
        return num !== undefined ? `[${num}]` : fullMatch;
      }
    );
  };

  // Сборка итогового Markdown-документа
  const outLines: string[] = [];
  const todayISO = new Date().toISOString().slice(0, 10);

  outLines.push("---");
  outLines.push(`направление: "Учёба"`);
  outLines.push(`тип: "Сборка"`);
  outLines.push(`проект: "[[${rootWork.name}]]"`);
  outLines.push(`дата_сборки: "${todayISO}"`);
  if (rootWork.discipline) {
    outLines.push(`дисциплина: ${JSON.stringify(rootWork.discipline)}`);
  }
  outLines.push("---");
  outLines.push("");
  outLines.push(`# ${rootWork.name}`);
  outLines.push("");

  if (config.includeRootBody && rootBodyText) {
    const cleanedRoot = config.stripLeadingH1
      ? removeLeadingHeadingIfMatches(rootBodyText, rootWork.name)
      : rootBodyText;
    if (cleanedRoot) {
      outLines.push(replaceCitationsInText(cleanedRoot));
      outLines.push("");
    }
  }

  let figureCounter = 0;
  let tableCounter = 0;

  // 1. Глоссарий терминов (если включён сбор терминов в отдельный раздел)
  const termNodes = includedNodes.filter((n) => n.item.noteType === "Термин");
  if (config.groupTermsIntoGlossary && termNodes.length > 0) {
    outLines.push("## Термины и определения");
    outLines.push("");
    for (const tn of termNodes) {
      const cleanTermBody = removeLeadingHeadingIfMatches(
        tn.bodyText,
        tn.item.name
      )
        .replace(/\r?\n+/g, " ")
        .trim();
      outLines.push(
        `- **${tn.item.name}** — ${replaceCitationsInText(cleanTermBody || "определение не заполнено")}`
      );
    }
    outLines.push("");
  }

  // 2. Основные разделы работы по дереву иерархии
  for (const node of includedNodes) {
    const t = node.item.noteType;
    if (config.buildBibliography && t === "Источник") continue;
    if (config.groupTermsIntoGlossary && t === "Термин") continue;

    const headingLevel = Math.min(6, node.depth + 2);
    const hashes = "#".repeat(headingLevel);
    const numPrefix =
      config.numberSections && node.sectionNumber !== "—"
        ? `${node.sectionNumber}. `
        : "";

    let sectionTitle = `${hashes} ${numPrefix}${node.item.name}`;
    if (config.autoNumberFiguresAndTables) {
      if (t === "Рисунок" || t === "Схема") {
        figureCounter++;
        sectionTitle = `${hashes} Рисунок ${figureCounter} — ${node.item.name}`;
      } else if (t === "Таблица") {
        tableCounter++;
        sectionTitle = `${hashes} Таблица ${tableCounter} — ${node.item.name}`;
      }
    }

    outLines.push(sectionTitle);
    outLines.push("");

    let body = config.stripLeadingH1
      ? removeLeadingHeadingIfMatches(node.bodyText, node.item.name)
      : node.bodyText;
    body = adjustInternalHeadings(body, headingLevel);
    body = replaceCitationsInText(body);

    if (body) {
      outLines.push(body);
      outLines.push("");
    }
  }

  // 3. Список использованных источников
  if (config.buildBibliography && orderedSourcesForBib.length > 0) {
    outLines.push("## Список использованных источников");
    outLines.push("");
    orderedSourcesForBib.forEach((sn, idx) => {
      const num = idx + 1;
      const entryText = formatBibliographyEntry(sn.item, sn.bodyText);
      outLines.push(`${num}. ${entryText}`);
    });
    outLines.push("");
  }

  const finalMarkdown = outLines.join("\n").trim() + "\n";
  const finalStats = countWordsAndFormulas(finalMarkdown);
  const markdownTablesCount =
    visualsTotal.filter((v) => v.noteType === "Таблица").length +
    (finalMarkdown.match(/\n\|[-:\s|]+\|\r?\n/g) ?? []).length;
  const embeddedImagesCount =
    visualsTotal.filter(
      (v) => v.noteType === "Рисунок" || v.noteType === "Схема"
    ).length +
    (finalMarkdown.match(/!\[\[[^\]]+\.(?:png|jpg|jpeg|webp|svg|gif)/gi) ?? [])
      .length;

  const audit: ProjectAuditReport = {
    totalNodes: nodes.length,
    includedNodes: includedNodes.length,
    totalWords: finalStats.words,
    totalCharsWithSpaces: finalStats.chars,
    authorSheets: (finalStats.chars / 40_000).toFixed(2).replace(".", ","),
    approxPages: Math.max(1, Math.ceil(finalStats.chars / 1800)),
    totalFormulas: finalStats.formulas,
    totalTables: markdownTablesCount,
    totalFigures: embeddedImagesCount,
    sourcesTotal,
    sourcesCited,
    sourcesUncited,
    visualsTotal,
    visualsReferenced,
    visualsUnreferenced,
    emptySectionNotes,
  };

  const safeFolder = (outputFolder || "Знания/Сборки").replace(/\/+$/, "");
  const safeName = rootWork.name.replace(/[\\/:*?"<>|]/g, "").trim();
  const outputFilePath = normalizePath(
    `${safeFolder}/Сборка — ${safeName}.md`
  );

  return {
    markdown: finalMarkdown,
    outputFilePath,
    audit,
  };
}

export async function ensureVaultFolderExists(app: App, folderPath: string) {
  let current = "";
  for (const part of normalizePath(folderPath).split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      try {
        await app.vault.createFolder(current);
      } catch {
        // Игнорируем, если папка уже создана параллельно
      }
    }
  }
}

export async function writeCompiledFileToVault(
  app: App,
  outputFilePath: string,
  markdown: string
): Promise<TFile> {
  const folder = outputFilePath.includes("/")
    ? outputFilePath.slice(0, outputFilePath.lastIndexOf("/"))
    : "";
  if (folder) {
    await ensureVaultFolderExists(app, folder);
  }

  const existing = app.vault.getAbstractFileByPath(outputFilePath);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, markdown);
    return existing;
  }
  return await app.vault.create(outputFilePath, markdown);
}