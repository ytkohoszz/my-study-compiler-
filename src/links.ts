import { App, TFile, getAllTags, normalizePath } from "obsidian";
import {
  KEYS,
  OutgoingLinkCandidate,
  StudyCompilerSettings,
  StudyNoteItem,
} from "./types";
import {
  ScanResult,
  collectDescendants,
  ensureFolder,
  flattenFrontmatterValue,
  isTemplateOrExcludedFile,
  resolveParentPaths,
} from "./scanner";

const NON_MD_EXT_RE =
  /\.(png|jpg|jpeg|gif|svg|webp|bmp|pdf|epub|mp3|wav|ogg|mp4|mov|webm|zip|rar|7z|csv|xlsx|docx|pptx)$/i;

function cleanLinkTargetText(rawLink: string): string {
  const withoutAlias = rawLink.split("|")[0] ?? "";
  const withoutHeading = withoutAlias.split("#")[0] ?? "";
  return withoutHeading.trim();
}

/**
 * Сканирует все заметки выбранной ветки/проекта (включая корень) и находит исходящие [[ссылки]] в тексте,
 * которые ещё не входят в это поддерево.
 */
export function scanUnlinkedOutgoingLinks(
  app: App,
  branchRoot: StudyNoteItem,
  projectRoot: StudyNoteItem,
  scan: ScanResult,
  settings: StudyCompilerSettings
): {
  allCandidates: OutgoingLinkCandidate[];
  bySourcePath: Map<string, OutgoingLinkCandidate[]>;
} {
  const branchPaths = collectDescendants(branchRoot.path, scan);
  branchPaths.add(branchRoot.path);

  const projectTreePaths = collectDescendants(projectRoot.path, scan);
  projectTreePaths.add(projectRoot.path);
  for (const r of scan.roots) {
    projectTreePaths.add(r.path);
  }

  const allCandidates: OutgoingLinkCandidate[] = [];
  const bySourcePath = new Map<string, OutgoingLinkCandidate[]>();

  for (const srcPath of branchPaths) {
    const srcItem = scan.byPath.get(srcPath);
    if (!srcItem) continue;

    const cache = app.metadataCache.getFileCache(srcItem.file);
    const bodyLinks = cache?.links ?? [];
    if (bodyLinks.length === 0) continue;

    const seenInSource = new Set<string>();

    for (const ref of bodyLinks) {
      const cleaned = cleanLinkTargetText(ref.link);
      if (!cleaned || NON_MD_EXT_RE.test(cleaned)) continue;

      const resolvedFile = app.metadataCache.getFirstLinkpathDest(
        cleaned,
        srcItem.path
      );

      if (resolvedFile instanceof TFile) {
        if (resolvedFile.extension.toLowerCase() !== "md") continue;
        if (resolvedFile.path === srcItem.path) continue;
        if (projectTreePaths.has(resolvedFile.path)) continue;

        const targetCache = app.metadataCache.getFileCache(resolvedFile);
        const targetFm = targetCache?.frontmatter;
        const rawTags = targetCache ? getAllTags(targetCache) ?? [] : [];
        const tagsLower = rawTags.map((t) => t.replace(/^#/, "").toLowerCase());

        if (isTemplateOrExcludedFile(resolvedFile, targetFm, tagsLower, settings)) {
          continue;
        }

        const dedupKey = `file:${resolvedFile.path}`;
        if (seenInSource.has(dedupKey)) continue;
        seenInSource.add(dedupKey);

        const existingParents = targetFm
          ? resolveParentPaths(app, resolvedFile, targetFm[KEYS.parent])
          : [];

        // Если среди родителей уже есть текущая заметка-источник, пропускаем
        if (existingParents.includes(srcItem.path)) continue;

        const candidate: OutgoingLinkCandidate = {
          id: `${srcItem.path}:::${resolvedFile.path}`,
          sourceFile: srcItem.file,
          sourcePath: srcItem.path,
          sourceName: srcItem.name,
          targetName: resolvedFile.basename,
          targetFile: resolvedFile,
          targetPath: resolvedFile.path,
          kind: existingParents.length > 0 ? "has-other-parent" : "existing-free",
          existingParents,
        };

        allCandidates.push(candidate);
        const list = bySourcePath.get(srcItem.path) ?? [];
        list.push(candidate);
        bySourcePath.set(srcItem.path, list);
      } else {
        // Несуществующая заметка (битая/будущая вики-ссылка)
        const baseName = (cleaned.split("/").pop() ?? cleaned)
          .replace(/\.md$/i, "")
          .replace(/[\\/:*?"<>|]/g, "")
          .trim();
        if (!baseName) continue;

        const dedupKey = `missing:${baseName.toLowerCase()}`;
        if (seenInSource.has(dedupKey)) continue;
        seenInSource.add(dedupKey);

        const hasExplicitSubfolder = cleaned.includes("/");
        const baseFolder = normalizePath(settings.newNoteFolder || "Знания");
        const targetPath = hasExplicitSubfolder
          ? normalizePath(cleaned.endsWith(".md") ? cleaned : `${cleaned}.md`)
          : normalizePath(`${baseFolder}/${baseName}.md`);

        const candidate: OutgoingLinkCandidate = {
          id: `${srcItem.path}:::missing:${targetPath}`,
          sourceFile: srcItem.file,
          sourcePath: srcItem.path,
          sourceName: srcItem.name,
          targetName: baseName,
          targetFile: null,
          targetPath,
          kind: "missing",
          existingParents: [],
        };

        allCandidates.push(candidate);
        const list = bySourcePath.get(srcItem.path) ?? [];
        list.push(candidate);
        bySourcePath.set(srcItem.path, list);
      }
    }
  }

  return { allCandidates, bySourcePath };
}

/**
 * Привязывает существующую или создаёт новую заметку по кандидату ссылки.
 * При наличии другого родителя не затирает его, а превращает поле `родитель` в массив.
 */
export async function applyOutgoingLinkCandidate(
  app: App,
  candidate: OutgoingLinkCandidate,
  noteType: string,
  projectRoot: StudyNoteItem,
  settings: StudyCompilerSettings
): Promise<boolean> {
  const chosenType = noteType.trim() || settings.defaultLinkNoteType || "Термин";
  const areaName = settings.studyAreaName || "Учёба";

  if (candidate.targetFile instanceof TFile) {
    const file = candidate.targetFile;
    const parentLink = `[[${app.metadataCache.fileToLinktext(
      candidate.sourceFile,
      file.path
    )}]]`;

    await app.fileManager.processFrontMatter(
      file,
      (fm: Record<string, unknown>) => {
        const currentAreas = flattenFrontmatterValue(fm[KEYS.area]);
        if (currentAreas.length === 0) {
          fm[KEYS.area] = areaName;
        } else if (!currentAreas.includes(areaName)) {
          fm[KEYS.area] = [...currentAreas, areaName];
        }

        if (!fm[KEYS.type] || String(fm[KEYS.type]).trim() === "") {
          fm[KEYS.type] = chosenType;
        }

        if (
          projectRoot.discipline &&
          (!fm[KEYS.discipline] || String(fm[KEYS.discipline]).trim() === "")
        ) {
          fm[KEYS.discipline] = projectRoot.discipline;
        }

        const existingRawParents = flattenFrontmatterValue(fm[KEYS.parent]);
        const alreadyResolved = resolveParentPaths(app, file, fm[KEYS.parent]);
        if (!alreadyResolved.includes(candidate.sourcePath)) {
          if (existingRawParents.length === 0) {
            fm[KEYS.parent] = parentLink;
          } else {
            fm[KEYS.parent] = [...existingRawParents, parentLink];
          }
        }
      }
    );
    return true;
  }

  // Создание новой заметки, если файла ещё не было
  const existingAbst = app.vault.getAbstractFileByPath(candidate.targetPath);
  if (existingAbst instanceof TFile) {
    return applyOutgoingLinkCandidate(
      app,
      { ...candidate, targetFile: existingAbst, kind: "existing-free" },
      chosenType,
      projectRoot,
      settings
    );
  }

  const folder = candidate.targetPath.includes("/")
    ? candidate.targetPath.slice(0, candidate.targetPath.lastIndexOf("/"))
    : normalizePath(settings.newNoteFolder || "Знания");

  await ensureFolder(app, folder);
  const parentLink = `[[${app.metadataCache.fileToLinktext(
    candidate.sourceFile,
    candidate.targetPath
  )}]]`;

  const lines = [
    "---",
    `${KEYS.area}: ${JSON.stringify(areaName)}`,
    `${KEYS.type}: ${JSON.stringify(chosenType)}`,
    `${KEYS.parent}: ${JSON.stringify(parentLink)}`,
  ];
  if (projectRoot.discipline) {
    lines.push(`${KEYS.discipline}: ${JSON.stringify(projectRoot.discipline)}`);
  }
  lines.push("---", "", `# ${candidate.targetName}`, "", "");

  await app.vault.create(candidate.targetPath, lines.join("\n"));
  return true;
}