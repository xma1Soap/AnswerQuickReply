/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface QRImage {
    id: string;
    name: string;
    dataUrl: string;
}

export interface QREntry {
    id: string;
    title: string;
    keywords: string[];
    weakKeywords: string[];
    content: string;
    images: QRImage[];
    favorite: boolean;
    sourceUrl?: string;
    updatedAt: number;
}

export interface QRArchive {
    version: 1;
    entries: QREntry[];
}

export interface QRMatch {
    entry: QREntry;
    score: number;
    reasons: string[];
}

export const QR_LIMITS = {
    entries: 300,
    imagesPerEntry: 10,
    imageBytes: 10 * 1024 * 1024,
    totalImageBytes: 64 * 1024 * 1024,
    archiveCharacters: 92 * 1024 * 1024,
    title: 120,
    content: 4000,
    keywords: 100,
    keywordLength: 120
} as const;

export function normalizeText(text: string): string {
    return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function keywordPattern(keyword: string): RegExp {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
    return /^\d+$/.test(keyword)
        ? new RegExp(`(?:^|[^\\p{Nd}])${escaped}(?!\\p{Nd})`, "u")
        : new RegExp(escaped, "u");
}

/** Each distinct trigger contributes once, even if repeated in text or several images. */
export function matchEntries(entries: QREntry[], sources: { text: string; label: string; }[]): QRMatch[] {
    const normalizedSources = sources.map(source => ({
        label: source.label,
        text: normalizeText(source.text),
        // OCR can wrap a word in the middle. Keep the ordinary version too, so
        // words separated by newlines still match ordinary multi-word phrases.
        joined: normalizeText(source.text.replace(/(\S)\r?\n[\t ]*(?=\S)/g, "$1"))
    }));
    const results: QRMatch[] = [];
    for (const entry of entries) {
        const seen = new Set<string>();
        const reasons: string[] = [];
        let strong = 0;
        let weak = 0;
        for (const [keywords, isStrong] of [[entry.keywords, true], [entry.weakKeywords, false]] as const) {
            for (const rawKeyword of keywords) {
                const keyword = normalizeText(rawKeyword);
                if (!keyword || seen.has(keyword)) continue;
                seen.add(keyword);
                const pattern = keywordPattern(keyword);
                const allowJoinedLines = !/^\d+$/.test(keyword);
                const source = normalizedSources.find(source => pattern.test(source.text) || (allowJoinedLines && pattern.test(source.joined)));
                if (!source) continue;
                if (isStrong) strong++;
                else weak++;
                reasons.push(`${source.label}：${rawKeyword}${isStrong ? "" : "（辅助词）"}`);
            }
        }
        if (strong || weak) results.push({
            entry,
            score: strong ? 100 + Math.min(strong - 1, 3) * 5 + Math.min(weak, 3) : Math.min(weak, 5) * 5,
            reasons
        });
    }
    return results.sort((a, b) => b.score - a.score || Number(b.entry.favorite) - Number(a.entry.favorite) || b.entry.updatedAt - a.entry.updatedAt);
}

/** Manual search is deliberately broader than automatic trigger matching. */
export function searchEntries(entries: QREntry[], query: string): QREntry[] {
    const terms = normalizeText(query).split(" ").filter(Boolean);
    return entries.filter(entry => {
        const text = normalizeText([entry.title, entry.content, ...entry.keywords, ...entry.weakKeywords].join(" "));
        return terms.every(term => text.includes(term));
    }).sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt - a.updatedAt);
}

function object(value: unknown, name: string, allowed: string[]): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name}格式不正确。`);
    if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${name}包含无法识别的字段。`);
    return value as Record<string, unknown>;
}

function string(value: unknown, name: string, max: number, required = false): string {
    if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw new Error(`${name}不能为空或超过 ${max} 个字符。`);
    return value;
}

function id(value: unknown, name: string): string {
    if (typeof value !== "string" || !/^[\w-]{1,128}$/.test(value)) throw new Error(`${name}无效。`);
    return value;
}

function keywords(value: unknown, name: string): string[] {
    if (!Array.isArray(value) || value.length > QR_LIMITS.keywords) throw new Error(`${name}最多 ${QR_LIMITS.keywords} 个。`);
    const seen = new Set<string>();
    return value.map(item => string(item, name, QR_LIMITS.keywordLength, true).trim()).filter(item => {
        const key = normalizeText(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function imageByteLength(dataUrl: string): number {
    const payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
    return payload.length / 4 * 3 - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
}

export function validateImage(value: unknown): QRImage {
    const image = object(value, "图片", ["id", "name", "dataUrl"]);
    const imageId = id(image.id, "图片 ID");
    const name = string(image.name, "图片文件名", 255, true);
    const dataUrl = string(image.dataUrl, "图片数据", Math.ceil(QR_LIMITS.imageBytes / 3) * 4 + 50, true);
    const match = /^data:image\/(png|jpeg|gif|webp);base64,/.exec(dataUrl);
    if (!match) throw new Error("图片必须是 PNG、JPEG、GIF 或 WebP 的 Base64 数据。");
    const mime = match[1];
    const payload = dataUrl.slice(match[0].length);
    const paddingAt = payload.indexOf("=");
    if (!payload.length || payload.length % 4 || /[^A-Za-z0-9+/=]/.test(payload)
        || (paddingAt !== -1 && !["=", "=="].includes(payload.slice(paddingAt)))) throw new Error("图片 Base64 数据不完整。");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if ((payload.endsWith("==") && alphabet.indexOf(payload.at(-3)!) % 16 !== 0)
        || (payload.endsWith("=") && !payload.endsWith("==") && alphabet.indexOf(payload.at(-2)!) % 4 !== 0)) throw new Error("图片 Base64 数据不规范。");
    if (imageByteLength(dataUrl) > QR_LIMITS.imageBytes) throw new Error("单张图片不能超过 10 MiB。");
    const header = atob(payload.slice(0, 24));
    const valid = mime === "png" ? header.startsWith("\x89PNG\r\n\x1a\n")
        : mime === "jpeg" ? header.startsWith("\xff\xd8\xff")
            : mime === "gif" ? /^(GIF87a|GIF89a)/.test(header)
                : header.startsWith("RIFF") && header.slice(8, 12) === "WEBP";
    if (!valid) throw new Error("图片类型与文件内容不符。");
    return { id: imageId, name, dataUrl };
}

export function validateEntry(value: unknown): QREntry {
    const entry = object(value, "QR", ["id", "title", "keywords", "weakKeywords", "content", "images", "favorite", "sourceUrl", "updatedAt"]);
    const entryId = id(entry.id, "QR ID");
    const title = string(entry.title, "QR 名称", QR_LIMITS.title, true).trim();
    const content = string(entry.content, "回复文字", QR_LIMITS.content);
    if (!Array.isArray(entry.images) || entry.images.length > QR_LIMITS.imagesPerEntry) throw new Error("每条 QR 最多保存 10 张图片。");
    const images = entry.images.map(validateImage);
    if (new Set(images.map(image => image.id)).size !== images.length) throw new Error("图片 ID 重复。");
    if (!content.trim() && !images.length) throw new Error("请填写回复文字或添加图片。");
    if (typeof entry.favorite !== "boolean") throw new Error("收藏设置无效。");
    if (typeof entry.updatedAt !== "number" || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 0) throw new Error("更新时间无效。");
    let sourceUrl: string | undefined;
    if (entry.sourceUrl !== undefined) {
        sourceUrl = string(entry.sourceUrl, "来源链接", 2048, true);
        let url: URL;
        try { url = new URL(sourceUrl); } catch { throw new Error("来源链接无效。"); }
        if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("来源链接必须为 HTTP(S) 地址。");
    }
    return {
        id: entryId, title, content, images,
        keywords: keywords(entry.keywords, "触发词"),
        weakKeywords: keywords(entry.weakKeywords, "辅助词"),
        favorite: entry.favorite,
        ...(sourceUrl === undefined ? {} : { sourceUrl }),
        updatedAt: entry.updatedAt
    };
}

export function validateArchive(value: unknown): QRArchive {
    const archive = object(value, "答疑库", ["version", "entries"]);
    if (archive.version !== 1) throw new Error("不支持此答疑库版本，需要 version: 1。");
    if (!Array.isArray(archive.entries) || archive.entries.length > QR_LIMITS.entries) throw new Error(`答疑库最多 ${QR_LIMITS.entries} 条 QR。`);
    const entries = archive.entries.map(validateEntry);
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error("导入文件中存在重复的 QR ID。");
    const bytes = entries.reduce((total, entry) => total + entry.images.reduce((sum, image) => sum + imageByteLength(image.dataUrl), 0), 0);
    if (bytes > QR_LIMITS.totalImageBytes) throw new Error("答疑库图片总量不能超过 64 MiB，请分批精简图片。");
    return { version: 1, entries };
}

export function parseArchive(json: string): QRArchive {
    if (typeof json !== "string" || json.length > QR_LIMITS.archiveCharacters) throw new Error("导入文件过大。");
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { throw new Error("导入文件不是有效的 JSON。"); }
    return validateArchive(parsed);
}

export function serializeArchive(entries: QREntry[]): string {
    return JSON.stringify(validateArchive({ version: 1, entries }), null, 2);
}
