/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

let active = false;
let host: HTMLDivElement | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function clearNotice() {
    clearTimeout(timer);
    timer = undefined;
    host?.remove();
    host = undefined;
}

export function startQrNotifications() {
    active = true;
}

export function stopQrNotifications() {
    active = false;
    clearNotice();
}

/** Keep notifications outside Discord's React tree and private toast APIs. */
export function showQrToast(message: string, type: "message" | "success" | "failure" = "message") {
    if (!active || typeof document === "undefined" || !document.body) return;
    try {
        clearNotice();
        const container = document.createElement("div");
        container.className = "aqr-toast-host";
        host = container;

        const notice = document.createElement("div");
        notice.className = `aqr-toast aqr-toast--${type}`;
        notice.setAttribute("role", type === "failure" ? "alert" : "status");
        notice.setAttribute("aria-atomic", "true");

        const text = document.createElement("span");
        text.className = "aqr-toast-message";
        text.textContent = message;

        const close = document.createElement("button");
        close.type = "button";
        close.className = "aqr-toast-close";
        close.textContent = "×";
        close.setAttribute("aria-label", "关闭答疑 QR 提示");
        close.onclick = () => { if (host === container) clearNotice(); };

        notice.append(text, close);
        container.append(notice);
        document.body.append(container);
        timer = setTimeout(() => {
            if (host === container) clearNotice();
        }, type === "failure" ? 10_000 : 3000);
    } catch {
        // Reporting an operation must never turn its success into a failure.
        clearNotice();
        console.warn("[AnswerQuickReply] 无法显示状态提示。");
    }
}
