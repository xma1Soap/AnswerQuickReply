/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Message, MessageAttachment } from "@vencord/discord-types";

/** Owned by one menu/panel, never a live Discord message or list position. */
export interface ReplyTarget {
    readonly id: string;
    readonly channel_id: string;
    readonly content: string;
    readonly author: Readonly<Pick<Message["author"], "id" | "username" | "globalName">>;
    readonly avatarUrl: string | undefined;
    readonly attachments: readonly Readonly<MessageAttachment>[];
}

export function snapshotReplyTarget(message: Message | ReplyTarget): ReplyTarget {
    let avatarUrl: string | undefined;
    try {
        avatarUrl = "avatarUrl" in message ? message.avatarUrl : message.author?.getAvatarURL?.(undefined, 64);
    } catch { /* The reply target does not depend on an available avatar. */ }

    return Object.freeze({
        id: message.id,
        channel_id: message.channel_id,
        content: message.content ?? "",
        author: Object.freeze({
            id: message.author?.id,
            username: message.author?.username,
            globalName: message.author?.globalName
        }),
        avatarUrl,
        attachments: Object.freeze((message.attachments ?? []).map(attachment => Object.freeze({ ...attachment })))
    });
}
