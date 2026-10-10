/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";
import { Menu, useState } from "@webpack/common";

import { clearRecognitionCache, errorText, imageAttachments, stopImageTools } from "./bridge";
import { startContributions, stopContributions } from "./contribute";
import { matchEntries, QREntry, searchEntries } from "./model";
import { showQrToast, startQrNotifications, stopQrNotifications } from "./notify";
import { loadRemoteConfig, startRemoteLibrary, stopRemoteLibrary } from "./remote";
import { sendReply } from "./send";
import { settings } from "./settings";
import { getEntries, loadLibrary } from "./store";
import { ReplyTarget, snapshotReplyTarget } from "./target";
import { captureMessage, openLibrary, SettingsPanel } from "./ui";

let menuTarget: ReplyTarget | undefined;

function quickSend(entry: QREntry, message: ReplyTarget) {
    showQrToast("正在发送答疑 QR…");
    sendReply(entry, message, settings.store.mentionReply)
        .then(() => showQrToast("答疑 QR 已发送", "success"))
        .catch(e => {
            const reason = errorText(e);
            console.error("[AnswerQuickReply]", reason);
            showQrToast(`发送失败：${reason}`, "failure");
        });
}

export default definePlugin({
    name: "AnswerQuickReply",
    description: "答疑 QR：内置社区云端库、收藏图文答复、关键词推荐、本地图片 OCR，右键引用并发送。",
    authors: [{ name: "Local QR Helper", id: 0n }],
    tags: ["Chat", "Utility"],
    settings,
    settingsAboutComponent: SettingsPanel,
    enabledByDefault: true,

    async start() {
        startQrNotifications();
        startRemoteLibrary();
        startContributions();
        void loadRemoteConfig().catch(() => {});
        try { await loadLibrary(); }
        catch (e) { showQrToast(`QR 库加载失败：${errorText(e)}`, "failure"); }
    },
    stop() {
        menuTarget = undefined;
        stopQrNotifications();
        stopRemoteLibrary();
        stopContributions();
        clearRecognitionCache();
        stopImageTools();
    },
    flux: {
        CONTEXT_MENU_OPEN() { menuTarget = undefined; },
        CONTEXT_MENU_CLOSE() { menuTarget = undefined; }
    },
    contextMenus: {
        message(children, { message: liveMessage }: { message?: Message; }) {
            // Context-menu patches run during render, as in Vencord's own menus.
            const [query, setQuery] = useState("");
            if (!liveMessage?.id || !liveMessage.channel_id) return;
            // The menu can render again while the message list moves. Keep the
            // first target for this menu; each action closes over its own copy.
            const message = menuTarget ??= snapshotReplyTarget(liveMessage);
            const menuId = `answer-qr-${message.channel_id}-${message.id}`;
            const entries = getEntries();
            const matches = matchEntries(entries, [{ text: message.content ?? "", label: "正文" }]).slice(0, 4);
            const ids = new Set(matches.map(m => m.entry.id));
            const favorites = entries.filter(e => e.favorite && !ids.has(e.id)).slice(0, 6);
            const searching = !!query.trim();
            const results = searching ? searchEntries(entries, query) : [];
            children.push(<Menu.MenuGroup key={menuId}>
                <Menu.MenuItem id={menuId} label="答疑 QR">
                    <Menu.MenuControlItem id={`${menuId}-keywords`} control={(props, ref) => <div onKeyDownCapture={e => {
                        // Enter confirms Chinese IME candidates; never let a search
                        // keypress activate a send action in the surrounding menu.
                        if (e.key === "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) e.stopPropagation();
                    }}>
                        <Menu.MenuSearchControl {...props} ref={ref} query={query} onChange={setQuery} placeholder="搜索本地 QR 关键词…" />
                    </div>} />
                    <Menu.MenuSeparator />
                    {searching ? <>
                        {results.slice(0, 10).map(entry => <Menu.MenuItem key={`${menuId}-${entry.id}`} id={`${menuId}-result-${entry.id}`} label={entry.title} action={() => quickSend(entry, message)} />)}
                        {!results.length && <Menu.MenuItem id={`${menuId}-empty`} label="没有匹配的本地 QR" disabled />}
                        {results.length > 10 && <Menu.MenuItem id={`${menuId}-more`} label={`查看全部 ${results.length} 条结果…`} action={() => openLibrary(message, false, query)} />}
                    </> : <>
                        {matches.map(({ entry, score }) => <Menu.MenuItem key={`${menuId}-${entry.id}`} id={`${menuId}-match-${entry.id}`} label={`${score >= 100 ? "推荐" : "可能相关"} · ${entry.title}`} action={() => quickSend(entry, message)} />)}
                        {favorites.map(entry => <Menu.MenuItem key={`${menuId}-${entry.id}`} id={`${menuId}-fav-${entry.id}`} label={`★ ${entry.title}`} action={() => quickSend(entry, message)} />)}
                    </>}
                    <Menu.MenuItem id={`${menuId}-search`} label="搜索 / 预览全部 QR…" action={() => openLibrary(message)} />
                    {!!imageAttachments(message).length && <Menu.MenuItem id={`${menuId}-ocr`} label="识别图片并查找 QR…" action={() => openLibrary(message, true)} />}
                </Menu.MenuItem>
                <Menu.MenuItem id={`${menuId}-save`} label="保存为答疑 QR…" action={() => captureMessage(message)} />
                <Menu.MenuItem id={`${menuId}-manage`} label="管理答疑 QR…" action={() => openLibrary()} />
            </Menu.MenuGroup>);
        }
    }
});
