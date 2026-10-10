/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { CloudUpload as DiscordCloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import { ChannelStore, PermissionsBits, PermissionStore, RestAPI, UserStore } from "@webpack/common";

import type { QREntry, QRImage } from "./model";
import type { ReplyTarget } from "./target";

const CloudUpload: typeof DiscordCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);
const sendingTargets = new Set<string>();
let lastNonce = 0n;

function nextNonce(): string {
    // A nonce is a decimal string. Build it locally so a Discord internal helper
    // rename cannot stop sending. Random low bits avoid another client's nonce;
    // the monotonic floor also handles several clicks in one ms or clock drift.
    const timestamp = (BigInt(Date.now()) - 1420070400000n) << 22n;
    const candidate = timestamp | BigInt(Math.floor(Math.random() * 0x400000));
    lastNonce = candidate > lastNonce ? candidate : lastNonce + 1n;
    return lastNonce.toString();
}

function sendFailureReason(error: unknown): string {
    if (typeof error === "string") return error;
    if (!error || typeof error !== "object") return "网络请求失败";
    const details = error as { body?: { message?: unknown; code?: unknown; }; message?: unknown; status?: unknown; };
    const message = typeof details.body?.message === "string" ? details.body.message
        : typeof details.message === "string" ? details.message : "网络请求失败";
    const status = typeof details.status === "number" ? `HTTP ${details.status}` : "";
    const code = typeof details.body?.code === "number" ? `Discord ${details.body.code}` : "";
    const context = [status, code].filter(Boolean).join("，");
    return context ? `${message}（${context}）` : message;
}

function imageFile(image: QRImage): File {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
    if (!match) throw new Error(`图片「${image.name}」不是有效的本地图片，请重新添加。`);
    const binary = atob(match[2]);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return new File([bytes], image.name || "answer.png", { type: match[1] });
}

function uploadImage(upload: DiscordCloudUpload, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        let finished = false;
        const finish = (error?: Error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            upload.removeListener("complete", complete);
            upload.removeListener("error", failed);
            signal.removeEventListener("abort", aborted);
            if (error) reject(error);
            else resolve();
        };
        const complete = () => {
            if (!upload.uploadedFilename) finish(new Error(`图片「${upload.filename}」未取得上传结果，消息尚未发送。`));
            else finish();
        };
        const failed = () => finish(new Error(`图片「${upload.filename}」上传失败，消息尚未发送。请检查网络和文件大小。`));
        const cancel = () => {
            try { upload.cancel(); } catch { /* Upload may already be stopped. */ }
        };
        const aborted = () => {
            finish(new Error("图片上传已取消，消息尚未发送。"));
            cancel();
        };
        const timer = setTimeout(() => {
            finish(new Error(`图片「${upload.filename}」上传超时，消息尚未发送。`));
            cancel();
        }, 90_000);

        upload.on("complete", complete);
        upload.on("error", failed);
        signal.addEventListener("abort", aborted, { once: true });
        try {
            Promise.resolve(upload.upload()).catch(failed);
        } catch {
            failed();
        }
    });
}

/** Send a single reply to the captured message, independent of the currently open channel. */
export async function sendReply(entry: QREntry, message: Pick<ReplyTarget, "id" | "channel_id">, mention: boolean): Promise<void> {
    const channelId = message.channel_id;
    const messageId = message.id;
    const target = `${channelId}:${messageId}`;
    if (sendingTargets.has(target)) throw new Error("正在发送对这条消息的回复，请勿重复点击。");
    const channel = ChannelStore.getChannel(channelId);
    if (!channel || !messageId) throw new Error("找不到原消息所在的频道，请重新打开消息后再试。");
    if (!entry.content.trim() && !entry.images.length) throw new Error("这条 QR 没有文字或图片。");
    if (entry.images.length > 10) throw new Error("一条回复最多支持 10 张图片，请编辑 QR 后重试。");

    const maxLength = UserStore.getCurrentUser()?.premiumType === 2 ? 4000 : 2000;
    if (entry.content.length > maxLength)
        throw new Error(`回复文字有 ${entry.content.length} 个字符，超过当前账户的 ${maxLength} 字符限制。请缩短 QR 后重试。`);

    if (channel.guild_id) {
        const sendPermission = channel.isThread() ? PermissionsBits.SEND_MESSAGES_IN_THREADS : PermissionsBits.SEND_MESSAGES;
        if (!PermissionStore.can(sendPermission, channel)) throw new Error("你没有在这个频道或帖子内发送消息的权限。");
        if (!PermissionStore.can(PermissionsBits.READ_MESSAGE_HISTORY, channel)) throw new Error("引用回复需要读取消息历史的权限。");
        if (entry.images.length && !PermissionStore.can(PermissionsBits.ATTACH_FILES, channel))
            throw new Error("你没有在这个频道发送图片附件的权限。");
    }

    sendingTargets.add(target);
    const uploads: DiscordCloudUpload[] = [];
    const uploadController = new AbortController();
    const guildId = channel.guild_id;
    let sent = false;
    let posting = false;
    try {
        // Keep the saved QR stable even if it is edited while attachments are uploading.
        const { content } = entry;
        const files = entry.images.map(imageFile);
        for (const file of files) {
            uploads.push(new CloudUpload({ file, isThumbnail: false, platform: CloudUploadPlatform.WEB }, channelId));
        }
        await Promise.all(uploads.map(upload => uploadImage(upload, uploadController.signal)));

        // Same client upload + REST path used by Vencord's VoiceMessages plugin.
        // Send only after every attachment succeeds; do not split text and images.
        const request = {
            url: `/channels/${channelId}/messages`,
            retries: 0,
            body: {
                content,
                tts: false,
                nonce: nextNonce(),
                enforce_nonce: true,
                allowed_mentions: { parse: [], replied_user: mention },
                message_reference: {
                    message_id: messageId,
                    channel_id: channelId,
                    ...(guildId ? { guild_id: guildId } : {}),
                    fail_if_not_exists: true
                },
                attachments: uploads.map((upload, index) => ({
                    id: String(index),
                    filename: upload.filename,
                    uploaded_filename: upload.uploadedFilename
                }))
            }
        };
        posting = true;
        const response = await RestAPI.post(request);
        if (!response?.body?.id) throw new Error("没有收到 Discord 的发送确认，请先检查频道，避免重复发送。");
        sent = true;
    } catch (error) {
        uploadController.abort();
        for (const upload of uploads) {
            if (upload.status !== "COMPLETED") {
                try { upload.cancel(); } catch { /* Preserve the original error. */ }
            }
        }
        if (posting) {
            const reason = sendFailureReason(error);
            throw new Error(`发送未获确认：${reason}。请先检查频道中是否已有回复，再决定是否重试。`);
        }
        throw error;
    } finally {
        // A small cooldown also catches a second click just after a fast request completes.
        if (sent || posting) setTimeout(() => sendingTargets.delete(target), 1500);
        else sendingTargets.delete(target);
    }
}
