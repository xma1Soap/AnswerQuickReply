/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import chineseData from "file://vendor/chi_sim.traineddata.gz?base64";
import englishData from "file://vendor/eng.traineddata.gz?base64";
import coreSource from "file://vendor/tesseract-core-lstm.wasm.js";
import simdCoreSource from "file://vendor/tesseract-core-simd-lstm.wasm.js";
import workerSource from "file://vendor/worker.min.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const LANGUAGES = ["en-US", "zh-Hans-CN"];
const STOPPED = "本地 OCR 已停止，请重新打开识图面板后重试。";

function supportsSimd() {
    // SIMD probe from wasm-feature-detect (Apache-2.0; bundled license in vendor/).
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
}

interface PendingJob {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timeout: ReturnType<typeof setTimeout>;
}

interface Session {
    worker: Worker;
    url: string;
    pending: Map<string, PendingJob>;
    ready: Promise<void>;
    closed: boolean;
}

let current: Session | undefined;
let nextJob = 0;
let generation = 0;
let queued = 0;
let queue: Promise<unknown> = Promise.resolve();
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function cancelIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = undefined;
}

function closeSession(session: Session, error: Error) {
    if (session.closed) return;
    session.closed = true;
    session.worker.terminate();
    URL.revokeObjectURL(session.url);
    for (const job of session.pending.values()) {
        clearTimeout(job.timeout);
        job.reject(error);
    }
    session.pending.clear();
    if (current === session) {
        current = undefined;
        cancelIdleTimer();
    }
}

function releaseWhenIdle(session: Session) {
    cancelIdleTimer();
    if (queued || session.closed || current !== session) return;
    idleTimer = setTimeout(() => closeSession(session, new Error("本地 OCR 已释放空闲资源。")), 60_000);
}

function command<T = unknown>(session: Session, action: string, payload: unknown, timeoutMs = 45_000): Promise<T> {
    if (session.closed) return Promise.reject(new Error(STOPPED));
    const jobId = String(++nextJob);
    return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
            closeSession(session, new Error("本地 OCR 处理超时，请尝试更小或更清晰的图片。"));
        }, timeoutMs);
        session.pending.set(jobId, { resolve: value => resolve(value as T), reject, timeout });
        try {
            session.worker.postMessage({ workerId: "answer-qr", jobId, action, payload });
        } catch {
            closeSession(session, new Error("无法向本地 OCR 线程传递图片，请重试。"));
        }
    });
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
    const raw = atob(value);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
}

async function initialize(session: Session) {
    await command(session, "load", { options: { lstmOnly: true, logging: false } });
    await command(session, "loadLanguage", {
        langs: [{ code: "eng", data: decodeBase64(englishData) }, { code: "chi_sim", data: decodeBase64(chineseData) }],
        options: { cacheMethod: "none", lstmOnly: true }
    });
    // Language objects are only accepted by loadLanguage; initialize needs their codes.
    await command(session, "initialize", { langs: "eng+chi_sim", oem: 1, config: {} });
    await command(session, "setParameters", { params: { tessedit_pageseg_mode: "3", preserve_interword_spaces: "1" } });
}

async function getSession(): Promise<Session> {
    cancelIdleTimer();
    if (!current) {
        if (typeof Worker === "undefined" || typeof WebAssembly === "undefined")
            throw new Error("此浏览器不支持本地 OCR，请使用较新的 Chrome、Edge 或 Firefox。");

        // Both scripts and compressed language data are compiled into the plugin.
        // Reject any accidental upstream fallback to a network engine/model download.
        const source = `self.fetch = () => Promise.reject(new Error("AnswerQuickReply OCR is offline"));
self.importScripts = () => { throw new Error("AnswerQuickReply OCR assets must be bundled"); };
${supportsSimd() ? simdCoreSource : coreSource}\n;\n${workerSource}`;
        const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
        let worker: Worker;
        try {
            worker = new Worker(url);
        } catch {
            URL.revokeObjectURL(url);
            throw new Error("浏览器阻止了本地 OCR 线程启动，请使用本插件配套的 Vencord 网页扩展。");
        }
        const session: Session = { worker, url, pending: new Map(), ready: Promise.resolve(), closed: false };
        current = session;
        worker.onmessage = event => {
            const { jobId, status, data } = event.data ?? {};
            const job = session.pending.get(jobId);
            if (!job || status === "progress") return;
            if (status === "reject") {
                closeSession(session, new Error("本地 OCR 识别失败，请尝试更清晰的图片或重新加载插件。"));
                return;
            }
            if (status !== "resolve") return;
            clearTimeout(job.timeout);
            session.pending.delete(jobId);
            job.resolve(data);
        };
        worker.onerror = event => {
            event.preventDefault();
            closeSession(session, new Error("本地 OCR 线程运行失败，请刷新 Discord 网页后重试。"));
        };
        worker.onmessageerror = () => closeSession(session, new Error("本地 OCR 数据传输失败，请重试。"));
        session.ready = initialize(session).catch(error => {
            closeSession(session, error instanceof Error ? error : new Error("本地 OCR 初始化失败。"));
            throw error;
        });
    }
    const session = current;
    await session.ready;
    if (session.closed) throw new Error(STOPPED);
    return session;
}

function decodeImage(dataUrl: string) {
    if (typeof dataUrl !== "string" || dataUrl.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40)
        throw new Error("图片不能超过 10 MB。");
    const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match || match[2].length % 4 !== 0) throw new Error("图片数据格式无效。");
    const bytes = decodeBase64(match[2]);
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("图片不能超过 10 MB。");
    return new Blob([bytes], { type: `image/${match[1]}` });
}

async function prepareImage(blob: Blob) {
    const bitmap = await createImageBitmap(blob).catch(() => { throw new Error("无法读取图片，请使用 PNG、JPEG、WebP 或 GIF 图片。"); });
    try {
        // Decode animated formats to one frame, flatten transparency, and bound OCR memory.
        const scale = Math.min(1, 4000 / Math.max(bitmap.width, bitmap.height), Math.sqrt(12_000_000 / (bitmap.width * bitmap.height)));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("浏览器无法处理图片画布。");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const png = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(result => result ? resolve(result) : reject(new Error("图片转换失败。")), "image/png");
        });
        canvas.width = canvas.height = 0;
        return new Uint8Array(await png.arrayBuffer());
    } finally {
        bitmap.close();
    }
}

export async function getOcrInfo(): Promise<{ available: boolean; languages: string[]; }> {
    try {
        const session = await getSession();
        releaseWhenIdle(session);
        return { available: true, languages: [...LANGUAGES] };
    } catch {
        return { available: false, languages: [] };
    }
}

export function recognizeImage(dataUrl: string): Promise<{ text: string; language: string; }> {
    const ticket = generation;
    queued++;
    cancelIdleTimer();
    const result = queue.then(async () => {
        if (ticket !== generation) throw new Error(STOPPED);
        const blob = decodeImage(dataUrl);
        const image = await prepareImage(blob);
        if (ticket !== generation) throw new Error(STOPPED);
        const session = await getSession();
        const data = await command<{ text?: string; }>(session, "recognize", { image, options: {}, output: { text: true } }, 90_000);
        return { text: String(data.text ?? ""), language: "eng+chi_sim" };
    }).finally(() => {
        queued--;
        if (current) releaseWhenIdle(current);
    });
    // A failed image must not poison the queue; the next request can start a new worker.
    queue = result.catch(() => { });
    return result;
}

export function stopWebOcr() {
    generation++;
    cancelIdleTimer();
    if (current) closeSession(current, new Error(STOPPED));
}
