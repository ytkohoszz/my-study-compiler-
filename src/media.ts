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

function isExternalImageUrl(raw: string): boolean {
  return /^https?:\/\/\S+/i.test(raw.trim());
}

function cleanWikiTarget(raw: string): string {
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

  const mediaItems: StudyMediaItem[] = [];
  const seenKeys = new Set<string>();

  const addVaultImage = (target: TFile) => {
    const key = target.name;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    mediaItems.push({
      key,
      label: target.basename,
      src: app.vault.adapter.getResourcePath(target.path),
      kind: "vault",
      file: target,
    });
  };

  const addExternalUrl = (url: string, customLabel?: string) => {
    const cleanUrl = url.trim();
    if (!cleanUrl || seenKeys.has(cleanUrl)) return;
    seenKeys.add(cleanUrl);
    let shortLabel = customLabel?.trim() || "";
    if (!shortLabel) {
      try {
        const u = new URL(cleanUrl);
        const lastSeg = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
        shortLabel = decodeURIComponent(lastSeg).slice(0, 28) || "Веб-схема";
      } catch {
        shortLabel = "Веб-схема";
      }
    }
    mediaItems.push({
      key: cleanUrl,
      label: shortLabel,
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
      addExternalUrl(linkPath, em.displayText);
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

  // 3. Подсчёт фигур в `схемы_аннотации` и восстановление холстов (включая чистый холст `__board__` или внешние URL)
  let annotationCount = 0;
  const rawAnnotations = fm?.[KEYS.annotations];
  if (rawAnnotations && typeof rawAnnotations === "object" && !Array.isArray(rawAnnotations)) {
    for (const [imgKey, list] of Object.entries(rawAnnotations as Record<string, unknown>)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      annotationCount += list.length;

      if (seenKeys.has(imgKey)) continue;

      if (imgKey === VIRTUAL_BOARD_KEY) {
        seenKeys.add(VIRTUAL_BOARD_KEY);
        mediaItems.push({
          key: VIRTUAL_BOARD_KEY,
          label: "Чистый холст",
          src: "",
          kind: "board",
        });
      } else if (isExternalImageUrl(imgKey)) {
        addExternalUrl(imgKey);
      } else {
        const dest = app.metadataCache.getFirstLinkpathDest(imgKey, file.path);
        if (
          dest instanceof TFile &&
          IMAGE_EXTENSIONS.has(dest.extension.toLowerCase())
        ) {
          addVaultImage(dest);
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
  if (!rawAnnotations || typeof rawAnnotations !== "object" || Array.isArray(rawAnnotations)) {
    return [];
  }

  const links: string[] = [];
  const wikiRegex = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

  for (const list of Object.values(rawAnnotations as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const el of list) {
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
 * Прикрепляет существующий в хранилище файл изображения или внешний URL к заметке:
 * дописывает embed в конец заметки (или в YAML для внешних URL), чтобы изображение сразу появилось в схеме.
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
 * Сохраняет бинарный буфер изображения (например, из буфера обмена на iPad/ПК) в папку вложений
 * и прикрепляет его к целевой заметке.
 */
export async function saveClipboardImageAndAttach(
  app: App,
  noteFile: TFile,
  buffer: ArrayBuffer,
  mimeType: string,
  mediaFolder: string
): Promise<TFile> {
  const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
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

  const safeBase = noteFile.basename.replace(/[\\/:*?"<>|]/g, "").slice(0, 32) || "scheme";
  const fileName = `${safeBase}_${Date.now()}.${ext}`;
  const fullPath = normalizePath(`${folder}/${fileName}`);

  const createdFile = await app.vault.createBinary(fullPath, buffer);
  await attachImageToNote(app, noteFile, {
    type: "vault",
    imageFile: createdFile,
  });
  return createdFile;
}