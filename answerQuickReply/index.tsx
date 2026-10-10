/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";
import { Menu, useEffect, useState } from "@webpack/common";

import { clearRecognitionCache, errorText, imageAttachments, stopImageTools } from "./bridge";
import { getContributionState, startContributions, stopContributions, subscribeContributions } from "./contribute";
import { loadRemoteFavorites, RemoteFavoriteScope, startRemoteFavorites, stopRemoteFavorites, subscribeRemoteFavorites } from "./favorites";
import { matchEntries, QREntry, searchEntries } from "./model";
import { showQrToast, startQrNotifications, stopQrNotifications } from "./notify";
import { ensureRemoteLibrary, getPersonalRemoteEntries, getRemoteFavoriteScope, getRemoteState, loadRemoteConfig, resolveRemoteEntry, startRemoteLibrary, stopRemoteLibrary, subscribeRemote } from "./remote";
import { sendReply } from "./send";
import { settings } from "./settings";
import { getEntries, loadLibrary, subscribe } from "./store";
import { ReplyTarget, snapshotReplyTarget } from "./target";
import { captureMessage, openLibrary, SettingsPanel } from "./ui";

let menuTarget: ReplyTarget | undefined;

function quickSend(entry: QREntry, message: ReplyTarget, scope?: RemoteFavoriteScope) {
    showQrToast("正在发送答疑 QR…");
    (scope ? resolveRemoteEntry(scope, entry.id) : Promise.resolve(entry))
        .then(current => sendReply(current, message, settings.store.mentionReply))
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
        startRemoteFavorites();
        startRemoteLibrary();
        startContributions();
        void loadRemoteConfig().catch(() => {});
        void loadRemoteFavorites().catch(e => showQrToast(`云端收藏加载失败：${errorText(e)}`, "failure"));
        try { await loadLibrary(); }
        catch (e) { showQrToast(`QR 库加载失败：${errorText(e)}`, "failure"); }
    },
    stop() {
        menuTarget = undefined;
        stopQrNotifications();
        stopRemoteFavorites();
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
            const [, setRevision] = useState(0);
            const remote = getRemoteState();
            const expiresAt = getContributionState().expiresAt;
            useEffect(() => {
                const changed = () => setRevision(value => value + 1);
                const unsubscribes = [subscribe(changed), subscribeRemote(changed), subscribeRemoteFavorites(changed), subscribeContributions(changed)];
                void loadRemoteFavorites().catch(() => {});
                return () => unsubscribes.forEach(unsubscribe => unsubscribe());
            }, []);
            useEffect(() => {
                if (expiresAt <= Date.now()) return;
                let timer: ReturnType<typeof setTimeout>;
                const expire = () => {
                    const remaining = expiresAt - Date.now();
                    if (remaining > 0) timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
                    else setRevision(value => value + 1);
                };
                expire();
                return () => clearTimeout(timer);
            }, [expiresAt]);
            useEffect(() => {
                if (remote.ready && !remote.saving) void ensureRemoteLibrary().catch(() => {});
            }, [remote.ready, remote.saving, remote.config]);
            if (!liveMessage?.id || !liveMessage.channel_id) return;
            // The menu can render again while the message list moves. Keep the
            // first target for this menu; each action closes over its own copy.
            const message = menuTarget ??= snapshotReplyTarget(liveMessage);
            const menuId = `answer-qr-${message.channel_id}-${message.id}`;
            const entries = getEntries();
            const cloudEntries = getPersonalRemoteEntries();
            const scope = getRemoteFavoriteScope();
            const matches = matchEntries(entries, [{ text: message.content ?? "", label: "正文" }]).slice(0, 4);
            const ids = new Set(matches.map(m => m.entry.id));
            const favorites = entries.filter(e => e.favorite && !ids.has(e.id)).slice(0, 6);
            const cloudFavorites = cloudEntries.filter(e => e.favorite).slice(0, 6);
            const searching = !!query.trim();
            const results = searching ? searchEntries(entries, query) : [];
            const cloudResults = searching ? searchEntries(cloudEntries, query) : [];
            const resultCount = results.length + cloudResults.length;
            children.push(<Menu.MenuGroup key={menuId}>
                <Menu.MenuItem id={menuId} label="答疑 QR">
                    <Menu.MenuControlItem id={`${menuId}-keywords`} control={(props, ref) => <div onKeyDownCapture={e => {
                        // Enter confirms Chinese IME candidates; never let a search
                        // keypress activate a send action in the surrounding menu.
                        if (e.key === "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) e.stopPropagation();
                    }}>
                        <Menu.MenuSearchControl {...props} ref={ref} query={query} onChange={setQuery} placeholder="搜索本地和云端 QR 关键词…" />
                    </div>} />
                    <Menu.MenuSeparator />
                    {searching ? <>
                        {results.slice(0, 10).map(entry => <Menu.MenuItem key={`${menuId}-local-${entry.id}`} id={`${menuId}-local-result-${entry.id}`} label={entry.title} action={() => quickSend(entry, message)} />)}
                        {scope && cloudResults.slice(0, 10).map(entry => <Menu.MenuItem key={`${menuId}-cloud-${entry.id}`} id={`${menuId}-cloud-result-${entry.id}`} label={`云端 · ${entry.title}`} action={() => quickSend(entry, message, scope)} />)}
                        {!resultCount && <Menu.MenuItem id={`${menuId}-empty`} label="没有匹配的 QR" disabled />}
                        {results.length > 10 && <Menu.MenuItem id={`${menuId}-more`} label={`查看全部 ${results.length} 条本地结果…`} action={() => openLibrary(message, false, query)} />}
                        {cloudResults.length > 10 && <Menu.MenuItem id={`${menuId}-cloud-more`} label={`查看全部 ${cloudResults.length} 条云端结果…`} action={() => openLibrary(message, false, query, "remote")} />}
                    </> : <>
                        {matches.map(({ entry, score }) => <Menu.MenuItem key={`${menuId}-local-${entry.id}`} id={`${menuId}-local-match-${entry.id}`} label={`${score >= 100 ? "推荐" : "可能相关"} · ${entry.title}`} action={() => quickSend(entry, message)} />)}
                        {favorites.map(entry => <Menu.MenuItem key={`${menuId}-local-${entry.id}`} id={`${menuId}-local-fav-${entry.id}`} label={`★ ${entry.title}`} action={() => quickSend(entry, message)} />)}
                        {scope && cloudFavorites.map(entry => <Menu.MenuItem key={`${menuId}-cloud-${entry.id}`} id={`${menuId}-cloud-fav-${entry.id}`} label={`★ 云端 · ${entry.title}`} action={() => quickSend(entry, message, scope)} />)}
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
