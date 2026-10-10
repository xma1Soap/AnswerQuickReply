/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ConnectSrc, CspPolicies } from "@main/csp";
import { execFile } from "child_process";
import { type IpcMainInvokeEvent, net } from "electron";
import { mkdtemp, rm, rmdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

import { OCR_SCRIPT } from "./ocrScript";

// Desktop keeps Discord's CSP. Register our exact HTTPS origin before the
// first document loads; both cloud reads and contribution requests need it.
// This grants connect-src only and leaves every other CSP directive intact.
CspPolicies["https://api.starmint.cc.cd"] = ConnectSrc;

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const runFile = promisify(execFile);
const encodedScript = Buffer.from(OCR_SCRIPT, "utf16le").toString("base64");
let recognizing = false;
let infoPromise: Promise<{ available: boolean; languages: string[]; }> | undefined;

function detectImageType(buffer: Buffer): string {
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
    if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "jpeg";
    if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.toString("ascii", 0, 6))) return "gif";
    if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
    throw new Error("仅支持 PNG、JPEG、WebP 和 GIF 图片。");
}

function decodeImage(dataUrl: string) {
    if (typeof dataUrl !== "string" || dataUrl.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40)
        throw new Error("图片不能超过 10 MB。");
    const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match || match[2].length % 4 !== 0) throw new Error("图片数据格式无效。");
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("图片不能超过 10 MB。");
    const type = detectImageType(bytes);
    if (type !== match[1]) throw new Error("图片格式与声明的类型不一致。");
    return { bytes, type };
}

function validateAttachmentUrl(value: string) {
    if (typeof value !== "string" || value.length > 8192) throw new Error("附件链接无效。");
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
        || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)
        || !/^\/(?:attachments|ephemeral-attachments)\/\d+\/\d+\/[^/\\]+$/.test(decodeURIComponent(url.pathname)))
        throw new Error("只能读取 Discord CDN 上的图片附件。");
    return url;
}

async function downloadAttachment(url: URL): Promise<Buffer> {
    const controller = new AbortController();
    // One wall-clock timeout covers all redirects and the response body.
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
        for (let redirects = 0; ; redirects++) {
            // Electron's network stack follows the client's proxy configuration.
            const response = await net.fetch(url.href, {
                redirect: "manual",
                credentials: "omit",
                signal: controller.signal,
                headers: { Accept: "image/png,image/jpeg,image/webp,image/gif" }
            });
            const { status } = response;
            if ([301, 302, 303, 307, 308].includes(status)) {
                await response.body?.cancel();
                const location = response.headers.get("location");
                if (!location || redirects >= 3) throw new Error("附件重定向次数过多。");
                url = validateAttachmentUrl(new URL(location, url).href);
                continue;
            }
            if (status !== 200) {
                await response.body?.cancel();
                throw new Error(`图片下载失败（HTTP ${status}），附件链接可能已过期。`);
            }
            if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) {
                await response.body?.cancel();
                throw new Error("图片不能超过 10 MB。");
            }
            if (!response.body) throw new Error("附件图片内容为空。");
            const reader = response.body.getReader();
            const chunks: Buffer[] = [];
            let length = 0;
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    length += value.byteLength;
                    if (length > MAX_IMAGE_BYTES) throw new Error("图片不能超过 10 MB。");
                    chunks.push(Buffer.from(value));
                }
                return Buffer.concat(chunks, length);
            } finally {
                await reader.cancel().catch(() => { });
                reader.releaseLock();
            }
        }
    } catch (error) {
        if (controller.signal.aborted) throw new Error("下载图片超时。");
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function runOcr(imagePath = "") {
    const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const { stdout } = await runFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript], {
        windowsHide: true,
        timeout: 45_000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: "utf8",
        env: { ...process.env, ANSWER_QUICK_REPLY_OCR_IMAGE: imagePath }
    });
    return JSON.parse(stdout.trim());
}

export async function getOcrInfo(_: IpcMainInvokeEvent): Promise<{ available: boolean; languages: string[]; }> {
    if (process.platform !== "win32") return { available: false, languages: [] };
    infoPromise ??= runOcr().then(result => ({ available: !!result.available, languages: result.languages ?? [] })).catch(() => {
        infoPromise = undefined;
        return { available: false, languages: [] };
    });
    return infoPromise;
}

export async function recognizeImage(_: IpcMainInvokeEvent, dataUrl: string): Promise<{ text: string; language: string; }> {
    if (process.platform !== "win32") throw new Error("此版本的本地 OCR 需要 Windows。");
    const { bytes, type } = decodeImage(dataUrl);
    if (recognizing) throw new Error("正在识别另一张图片，请稍后重试。");
    recognizing = true;
    let directory: string | undefined;
    try {
        directory = await mkdtemp(join(tmpdir(), "vencord-answer-qr-"));
        const imagePath = join(directory, `input.${type}`);
        await writeFile(imagePath, bytes, { flag: "wx" });
        const result = await runOcr(imagePath);
        return { text: String(result.text ?? ""), language: String(result.language ?? "") };
    } catch {
        throw new Error("Windows OCR 识别失败：请确认已安装中/英文 OCR 语言包，并尝试清晰的 PNG 或 JPEG 图片。");
    } finally {
        try {
            if (directory) {
                await rm(join(directory, `input.${type}`), { force: true });
                await rmdir(directory);
            }
        } finally {
            recognizing = false;
        }
    }
}

export async function fetchImage(_: IpcMainInvokeEvent, value: string): Promise<{ dataUrl: string; name: string; }> {
    const url = validateAttachmentUrl(value);
    const bytes = await downloadAttachment(url);
    const type = detectImageType(bytes);
    let name: string;
    try {
        name = decodeURIComponent(url.pathname.split("/").pop()!).replace(/[\\/\x00-\x1f\x7f]/g, "_").slice(0, 180);
    } catch {
        name = `image.${type}`;
    }
    return { dataUrl: `data:image/${type};base64,${bytes.toString("base64")}`, name };
}
