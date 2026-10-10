/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MANUAL_IMAGE_HINT = "可先下载图片，再在 QR 编辑器中手动添加本地图片。";
const downloads = new Set<AbortController>();
let generation = 0;

export function stopWebImageDownloads(): void {
    generation++;
    for (const controller of downloads) controller.abort();
    downloads.clear();
}

function validateAttachmentUrl(value: string): URL {
    let url: URL;
    let pathname: string;
    try {
        if (typeof value !== "string" || value.length > 8192) throw new Error();
        url = new URL(value);
        pathname = decodeURIComponent(url.pathname);
    } catch {
        throw new Error("附件链接无效。");
    }
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
        || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)
        || !/^\/(?:attachments|ephemeral-attachments)\/\d+\/\d+\/[^/\\\x00-\x1f\x7f]+$/.test(pathname))
        throw new Error("只能读取 Discord CDN 上的图片附件。");
    return url;
}

function detectImageType(bytes: Uint8Array): string {
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return "png";
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpeg";
    const head = String.fromCharCode(...bytes.subarray(0, 12));
    if (bytes.length >= 6 && /^GIF8[79]a/.test(head)) return "gif";
    if (bytes.length >= 12 && head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "webp";
    throw new Error("仅支持 PNG、JPEG、WebP 和 GIF 图片，附件内容不是有效的图片格式。");
}

async function downloadAttachment(url: URL): Promise<Uint8Array<ArrayBuffer>> {
    const controller = new AbortController();
    const ticket = generation;
    downloads.add(controller);
    // The same deadline covers the request and the entire response stream.
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
        const response = await fetch(url.href, {
            mode: "cors",
            // Browsers conceal cross-origin redirect targets; refuse redirects
            // instead of following them outside the attachment allowlist.
            redirect: "error",
            credentials: "omit",
            signal: controller.signal,
            headers: { Accept: "image/png,image/jpeg,image/webp,image/gif" }
        });
        if (response.status !== 200) {
            await response.body?.cancel().catch(() => { });
            throw new Error(`图片下载失败（HTTP ${response.status}），附件链接可能已过期。${MANUAL_IMAGE_HINT}`);
        }
        if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) {
            await response.body?.cancel().catch(() => { });
            throw new Error("图片不能超过 10 MB。");
        }
        if (!response.body) throw new Error("附件图片内容为空。");

        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                length += value.byteLength;
                if (length > MAX_IMAGE_BYTES) throw new Error("图片不能超过 10 MB。");
                chunks.push(value);
            }
            if (!length) throw new Error("附件图片内容为空。");
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
            return bytes;
        } finally {
            await reader.cancel().catch(() => { });
            reader.releaseLock();
        }
    } catch (error) {
        if (ticket !== generation) throw new Error("答疑 QR 已停用，图片下载已取消。");
        if (controller.signal.aborted) throw new Error(`下载图片超时。${MANUAL_IMAGE_HINT}`);
        if (error instanceof TypeError)
            throw new Error(`浏览器无法读取附件：可能是网络故障、跨域限制、重定向或链接过期。${MANUAL_IMAGE_HINT}`);
        throw error;
    } finally {
        clearTimeout(timer);
        downloads.delete(controller);
    }
}

function readDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("读取下载的图片失败，请重试。"));
        reader.onabort = () => reject(new Error("读取下载的图片已取消。"));
        reader.onload = () => typeof reader.result === "string"
            ? resolve(reader.result)
            : reject(new Error("读取下载的图片失败，请重试。"));
        reader.readAsDataURL(blob);
    });
}

/** Browser-only attachment download. Never uses Electron, credentials or a proxy. */
export async function fetchImage(value: string): Promise<{ dataUrl: string; name: string; }> {
    const ticket = generation;
    const url = validateAttachmentUrl(value);
    const bytes = await downloadAttachment(url);
    if (ticket !== generation) throw new Error("答疑 QR 已停用，图片下载已取消。");
    const type = detectImageType(bytes);
    const name = decodeURIComponent(url.pathname.split("/").pop()!).replace(/[\\/\x00-\x1f\x7f]/g, "_").slice(0, 180);
    const dataUrl = await readDataUrl(new Blob([bytes], { type: `image/${type}` }));
    if (ticket !== generation) throw new Error("答疑 QR 已停用，图片读取已取消。");
    return { dataUrl, name };
}
