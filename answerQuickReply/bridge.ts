/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";

import { QRImage } from "./model";
import type { ReplyTarget } from "./target";
import { fetchImage as fetchWebImage, stopWebImageDownloads } from "./webImages";
import { getOcrInfo, recognizeImage, stopWebOcr } from "./webOcr";

export function imageTools() {
    if (IS_WEB) return { fetchImage: fetchWebImage, getOcrInfo, recognizeImage };
    const helper = VencordNative.pluginHelpers.AnswerQuickReply as PluginNative<typeof import("./native")>;
    if (!helper) throw new Error("本地识图模块尚未加载，请从托盘完全退出 Discord 后重新打开。");
    return helper;
}

export function stopImageTools() {
    if (IS_WEB) {
        stopWebImageDownloads();
        stopWebOcr();
    }
}

export function imageAttachments(message: Pick<ReplyTarget, "attachments">) {
    return (message.attachments ?? []).filter(a =>
        /^image\/(png|jpeg|webp|gif)$/i.test(a.content_type ?? "")
        || /\.(png|jpe?g|webp|gif)$/i.test(a.filename ?? "")
    );
}

export function fileToImage(file: File): Promise<QRImage> {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return Promise.reject(new Error("请选择 PNG、JPEG、WebP 或 GIF 图片。"));
    if (file.size > 10 * 1024 * 1024) return Promise.reject(new Error("每张图片最多 10 MB。"));
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("读取图片失败。"));
        reader.onabort = () => reject(new Error("读取图片已取消，请重新选择。"));
        reader.onload = () => typeof reader.result === "string"
            ? resolve({ id: crypto.randomUUID(), name: file.name, dataUrl: reader.result })
            : reject(new Error("读取图片失败。"));
        reader.readAsDataURL(file);
    });
}

const recognitionCache = new Map<string, string>();
let recognitionGeneration = 0;

export async function recognizeAttachment(message: Pick<ReplyTarget, "id" | "attachments">, index: number): Promise<string> {
    const generation = recognitionGeneration;
    const attachment = imageAttachments(message)[index];
    if (!attachment) throw new Error("这条消息没有可识别的图片附件。");
    const key = `${message.id}:${attachment.id}:${attachment.url}`;
    const cached = recognitionCache.get(key);
    if (cached !== undefined) return cached;
    const image = await imageTools().fetchImage(attachment.url);
    if (generation !== recognitionGeneration) throw new Error("识图任务已取消，请重新打开识图面板后重试。");
    const result = await imageTools().recognizeImage(image.dataUrl);
    if (generation !== recognitionGeneration) throw new Error("识图任务已取消，请重新打开识图面板后重试。");
    if (recognitionCache.size >= 50) recognitionCache.delete(recognitionCache.keys().next().value!);
    recognitionCache.set(key, result.text);
    return result.text;
}

export function clearRecognitionCache() {
    recognitionGeneration++;
    recognitionCache.clear();
}

export function errorText(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}
