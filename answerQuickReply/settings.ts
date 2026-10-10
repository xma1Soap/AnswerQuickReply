/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    mentionReply: {
        type: OptionType.BOOLEAN,
        description: "发送答疑 QR 时提醒被回复的人",
        default: false
    }
});
