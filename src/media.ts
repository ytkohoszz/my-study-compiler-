// C:\Users\user\dev\my-study-compiler\src\media.ts
import { App, TFile, normalizePath } from "obsidian";
import { KEYS, StudyMediaItem } from "./types";

export const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "svg",
  "bmp",
  "avif",
]);

export const VIRTUAL_BOARD_KEY = "__board__";

const YAML_MEDIA_KEYS = [
  "изображение",
  "изображения",
  "картинка",
  "схема",
  "медиа",
  "обложка",
  "image",
  "media",
];

export function isExternalImageUrl(raw: string): boolean {
  return /^https?:\/\/\S+/i.test(raw.trim());
}

export function cleanWikiTarget(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("!")) s = s.slice(1).trim();
  if (s.startsWith("[[")) s = s.slice(2);
  if (s.endsWith("]]")) s = s.slice(0, -2);
  return s.split("|")[0]?.split("#")[0]?.trim() ?? "";
}

function flattenUnknownStrings(val: unknown): string[] {
  if (val === null || val === undefined) return [];
  if (Array.isArray(val)) {
    const out: string[] = [];
    for (const item of val) out.push(...flattenUnknownStrings(item));
    return out;
  }
  if (typeof val === "string") {
    const t = val.trim();
    return t ? [t] : [];
  }
  return [];
}

export function isVirtualBoardKey(key: string): boolean {
  return (
    key === VIRTUAL_BOARD_KEY ||
    /^__board_\d+__$/.test(key) ||
    /^холст[_\s-]*\d+$/i.test(key)
  );
}

export function formatBoardLabel(key: string, indexFallback = 1): string {
  return `Холст ${indexFallback}`;
}

function extractRawBoardEntry(rawEntry: unknown): {
  title?: string;
  elements: unknown[];
  deleted: boolean;
} | null {
  if (Array.isArray(rawEntry)) {
    return { elements: rawEntry, deleted: false };
  }
  if (rawEntry && typeof rawEntry === "object") {
    const rec = rawEntry as Record<string, unknown>;
    if (rec["deleted"] === true) {
      return { elements: [], deleted: true };
    }
    const title =
      typeof rec["title"] === "string" && rec["title"].trim().length > 0
        ? rec["title"].trim()
        : undefined;
    const elements = Array.isArray(rec["elements"]) ? rec["elements"] : [];
    return { title, elements, deleted: false };
  }
  return null;
}

/**
 * Разрешает строковый ключ картинки (имя файла в хранилище, вики-ссылку или внешний URL)
 * в пригодный для <img src="..."> адрес.
 */
export function resolveImageSource(
  app: App,
  rawKey: string,
  notePath: string
): { src: string; label: string; file?: TFile } {
  const trimmed = String(rawKey ?? "").trim();
  if (!trimmed) return { src: "", label: "Картинка" };

  if (
    isExternalImageUrl(trimmed) ||
    trimmed.startsWith("app://") ||
    trimmed.startsWith("data:image/")
  ) {
    let shortLabel = "Веб-схема";
    try {
      const u = new URL(trimmed);
      const lastSeg = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
      shortLabel = decodeURIComponent(lastSeg).slice(0, 28) || "Веб-схема";
    } catch {
      shortLabel = "Веб-схема";
    }
    return { src: trimmed, label: shortLabel };
  }

  const cleaned = cleanWikiTarget(trimmed);
  if (!cleaned) return { src: "", label: "Картинка" };

  const direct = app.vault.getAbstractFileByPath(cleaned);
  if (direct instanceof TFile && IMAGE_EXTENSIONS.has(direct.extension.toLowerCase())) {
    return {
      src: app.vault.adapter.getResourcePath(direct.path),
      label: direct.basename,
      file: direct,
    };
  }

  const dest = app.metadataCache.getFirstLinkpathDest(cleaned, notePath || "");
  if (dest instanceof TFile && IMAGE_EXTENSIONS.has(dest.extension.toLowerCase())) {
    return {
      src: app.vault.adapter.getResourcePath(dest.path),
      label: dest.basename,
      file: dest,
    };
  }

  return { src: "", label: cleaned };
}

/**
 * Синхронно собирает все прикреплённые изображения и холсты схем для учебной заметки
 * (из cache.embeds, YAML-свойств и уже сохранённых ключей `схемы_аннотации`).
 */
export function extractMediaAndAnnotationMeta(
  app: App,
  file: TFile
): { mediaItems: StudyMediaItem[]; annotationCount: number } {
  const cache = app.metadataCache.getFileCache(file);
  const fm = cache?.frontmatter as Record<string, unknown> | undefined;

  const rawAnnotations = fm?.[KEYS.annotations];
  const deletedKeys = new Set<string>();
  const customTitles = new Map<string, string>();

  if (
    rawAnnotations &&
    typeof rawAnnotations === "object" &&
    !Array.isArray(rawAnnotations)
  ) {
    for (const [k, rawVal] of Object.entries(
      rawAnnotations as Record<string, unknown>
    )) {
      const parsed = extractRawBoardEntry(rawVal);
      if (!parsed) continue;
      if (parsed.deleted) {
        deletedKeys.add(k);
      } else if (parsed.title) {
        customTitles.set(k, parsed.title);
      }
    }
  }

  const mediaItems: StudyMediaItem[] = [];
  const seenKeys = new Set<string>();

  const addVaultImage = (target: TFile, customKey?: string) => {
    const key = customKey || target.name;
    if (seenKeys.has(key) || deletedKeys.has(key)) return;
    seenKeys.add(key);
    const customTitle = customTitles.get(key);
    const defaultLabel = `Холст ${mediaItems.length + 1}`;
    mediaItems.push({
      key,
      label: customTitle || defaultLabel,
      customTitle,
      src: app.vault.adapter.getResourcePath(target.path),
      kind: "vault",
      file: target,
    });
  };

  const addExternalUrl = (url: string) => {
    const cleanUrl = url.trim();
    if (!cleanUrl || seenKeys.has(cleanUrl) || deletedKeys.has(cleanUrl)) return;
    seenKeys.add(cleanUrl);
    const customTitle = customTitles.get(cleanUrl);
    const defaultLabel = `Холст ${mediaItems.length + 1}`;
    mediaItems.push({
      key: cleanUrl,
      label: customTitle || defaultLabel,
      customTitle,
      src: cleanUrl,
      kind: "external",
    });
  };

  // 1. Вложения из тела заметки (![[image.png]])
  const embeds = cache?.embeds ?? [];
  for (const em of embeds) {
    const linkPath = cleanWikiTarget(em.link);
    if (!linkPath) continue;
    if (isExternalImageUrl(linkPath)) {
      addExternalUrl(linkPath);
      continue;
    }
    const dest = app.metadataCache.getFirstLinkpathDest(linkPath, file.path);
    if (
      dest instanceof TFile &&
      IMAGE_EXTENSIONS.has(dest.extension.toLowerCase())
    ) {
      addVaultImage(dest);
    }
  }

  // 2. Ссылки на медиа в YAML-свойствах (`изображение`, `медиа`, `схема` и др.)
  if (fm) {
    for (const k of YAML_MEDIA_KEYS) {
      for (const rawVal of flattenUnknownStrings(fm[k])) {
        if (isExternalImageUrl(rawVal)) {
          addExternalUrl(rawVal);
          continue;
        }
        const cleaned = cleanWikiTarget(rawVal);
        if (!cleaned) continue;
        const dest = app.metadataCache.getFirstLinkpathDest(cleaned, file.path);
        if (
          dest instanceof TFile &&
          IMAGE_EXTENSIONS.has(dest.extension.toLowerCase())
        ) {
          addVaultImage(dest);
        }
      }
    }
  }

  // 3. Подсчёт элементов в `схемы_аннотации` и восстановление всех сохранённых холстов
  let annotationCount = 0;
  if (
    rawAnnotations &&
    typeof rawAnnotations === "object" &&
    !Array.isArray(rawAnnotations)
  ) {
    for (const [canvasKey, rawVal] of Object.entries(
      rawAnnotations as Record<string, unknown>
    )) {
      const parsed = extractRawBoardEntry(rawVal);
      if (!parsed || parsed.deleted) continue;

      annotationCount += parsed.elements.length;

      if (seenKeys.has(canvasKey)) continue;

      const customTitle = parsed.title;
      const defaultLabel = `Холст ${mediaItems.length + 1}`;

      if (isVirtualBoardKey(canvasKey)) {
        seenKeys.add(canvasKey);
        mediaItems.push({
          key: canvasKey,
          label: customTitle || defaultLabel,
          customTitle,
          src: "",
          kind: "board",
        });
      } else if (isExternalImageUrl(canvasKey)) {
        addExternalUrl(canvasKey);
      } else {
        const dest = app.metadataCache.getFirstLinkpathDest(canvasKey, file.path);
        if (
          dest instanceof TFile &&
          IMAGE_EXTENSIONS.has(dest.extension.toLowerCase())
        ) {
          addVaultImage(dest, canvasKey);
        } else {
          seenKeys.add(canvasKey);
          mediaItems.push({
            key: canvasKey,
            label: customTitle || defaultLabel,
            customTitle,
            src: "",
            kind: "board",
          });
        }
      }
    }
  }

  return { mediaItems, annotationCount };
}

/**
 * Извлекает все вики-ссылки `[[...]]`, написанные внутри текстовых блоков на схемах (`схемы_аннотации`),
 * чтобы термины со схем автоматически встраивались в иерархию проекта.
 */
export function extractWikiLinksFromAnnotations(
  fm: Record<string, unknown> | undefined
): string[] {
  if (!fm) return [];
  const rawAnnotations = fm[KEYS.annotations];
  if (
    !rawAnnotations ||
    typeof rawAnnotations !== "object" ||
    Array.isArray(rawAnnotations)
  ) {
    return [];
  }

  const links: string[] = [];
  const wikiRegex = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

  for (const rawVal of Object.values(
    rawAnnotations as Record<string, unknown>
  )) {
    const parsed = extractRawBoardEntry(rawVal);
    if (!parsed || parsed.deleted) continue;
    for (const el of parsed.elements) {
      if (!el || typeof el !== "object") continue;
      const rec = el as Record<string, unknown>;
      if (rec["type"] === "text" && typeof rec["text"] === "string") {
        let match: RegExpExecArray | null;
        wikiRegex.lastIndex = 0;
        while ((match = wikiRegex.exec(rec["text"])) !== null) {
          const target = match[1]?.trim();
          if (target) links.push(target);
        }
      }
    }
  }

  return links;
}

/**
 * Прикрепляет существующий в хранилище файл изображения или внешний URL к заметке.
 */
export async function attachImageToNote(
  app: App,
  noteFile: TFile,
  source: { type: "vault"; imageFile: TFile } | { type: "url"; url: string }
): Promise<void> {
  if (source.type === "vault") {
    const linkText = app.metadataCache.fileToLinktext(
      source.imageFile,
      noteFile.path
    );
    const embedSyntax = `![[${linkText}]]`;
    const content = await app.vault.read(noteFile);
    if (!content.includes(embedSyntax)) {
      const prefix = content.endsWith("\n") ? "\n" : "\n\n";
      await app.vault.modify(noteFile, `${content}${prefix}${embedSyntax}\n`);
    }
    return;
  }

  const cleanUrl = source.url.trim();
  if (!cleanUrl) return;

  await app.fileManager.processFrontMatter(
    noteFile,
    (fm: Record<string, unknown>) => {
      const cur = fm["медиа"];
      if (!cur) {
        fm["медиа"] = [cleanUrl];
      } else if (Array.isArray(cur)) {
        if (!cur.includes(cleanUrl)) cur.push(cleanUrl);
      } else if (typeof cur === "string" && cur !== cleanUrl) {
        fm["медиа"] = [cur, cleanUrl];
      }
    }
  );
}

/**
 * Сохраняет бинарный буфер изображения (из буфера обмена или drag-and-drop) в папку вложений
 * без принудительного создания нового слайда в теле заметки.
 */
export async function saveBinaryImageToVault(
  app: App,
  noteFile: TFile,
  buffer: ArrayBuffer,
  mimeTypeOrExt: string,
  mediaFolder: string
): Promise<TFile> {
  const rawExt = mimeTypeOrExt.includes("/")
    ? mimeTypeOrExt.split("/")[1] || "png"
    : mimeTypeOrExt.replace(/^\./, "") || "png";
  const ext = rawExt.toLowerCase().replace("jpeg", "jpg");
  const folder = normalizePath(mediaFolder || "Знания/Вложения");

  let cur = "";
  for (const part of folder.split("/").filter(Boolean)) {
    cur = cur ? `${cur}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(cur)) {
      try {
        await app.vault.createFolder(cur);
      } catch {
        // папка уже существует
      }
    }
  }

  const safeBase =
    noteFile.basename.replace(/[\\/:*?"<>|]/g, "").slice(0, 32) || "scheme";
  const fileName = `${safeBase}_${Date.now()}.${ext}`;
  const fullPath = normalizePath(`${folder}/${fileName}`);

  return await app.vault.createBinary(fullPath, buffer);
}

/**
 * Сохраняет изображение из буфера обмена и прикрепляет к заметке (оставлено для обратной совместимости).
 */
export async function saveClipboardImageAndAttach(
  app: App,
  noteFile: TFile,
  buffer: ArrayBuffer,
  mimeType: string,
  mediaFolder: string
): Promise<TFile> {
  return await saveBinaryImageToVault(app, noteFile, buffer, mimeType, mediaFolder);
}