/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

import { getContributionState, getLibrarySessionToken, invalidateLibrarySession } from "./contribute";
import { isRemoteFavorite, RemoteFavoriteScope, setRemoteFavorite } from "./favorites";
import { parseArchive, QR_LIMITS, QREntry, validateEntry } from "./model";
import { copyEntriesLocally, saveEntry } from "./store";

export interface RemoteConfig { url: string; accessKey: string; }
export interface RemoteState {
    readonly config: Readonly<RemoteConfig>;
    readonly ready: boolean;
    readonly saving: boolean;
    readonly loading: boolean;
    readonly entries: QREntry[];
    readonly fetchedAt: number | null;
    readonly stale: boolean;
    readonly error: string;
}

const CONFIG_KEY = "AnswerQuickReply_remote_config_v1";
export const DEFAULT_REMOTE_URL = "https://api.starmint.cc.cd/answer-qr/library.json";
export const REMOTE_CACHE_MS = 5 * 60_000;
export const REMOTE_RETRY_MS = 60_000;
export const REMOTE_MAX_BYTES = 32 * 1024 * 1024;
const emptyEntries = Object.freeze([]) as unknown as QREntry[];
const LOGIN_HINT = "请点击「Discord 登录 / 投稿」，用拥有答疑身份组的 Discord 账号登录。本地 QR 不受影响。";
const defaultConfig = Object.freeze({ url: DEFAULT_REMOTE_URL, accessKey: "" });
const listeners = new Set<() => void>();
let state: RemoteState = Object.freeze({ config: defaultConfig, ready: false, saving: false, loading: false, entries: emptyEntries, fetchedAt: null, stale: false, error: "" });
let active = false;
let generation = 0;
let lifecycle = 0;
let loadingConfig: Promise<void> | undefined;
let writingConfig: Promise<unknown> = Promise.resolve();
let request: { controller: AbortController; promise: Promise<void>; } | undefined;
let retryAfter = 0;

function update(next: Partial<RemoteState>): void {
    state = Object.freeze({ ...state, ...next });
    for (const listener of listeners) {
        try { listener(); } catch { /* A view must not change the download result. */ }
    }
}

function assertActive(): void {
    if (!active) throw new Error("答疑 QR 已停用，请重新启用后操作。");
}

export function validateRemoteConfig(value: unknown): Readonly<RemoteConfig> {
    if (!value || typeof value !== "object") throw new Error("云端连接设置格式不正确。");
    const { url, accessKey } = value as RemoteConfig;
    if (typeof url !== "string" || url.length > 4096 || typeof accessKey !== "string" || accessKey.length > 4096)
        throw new Error("云端地址或只读密钥格式不正确。");
    const address = url.trim();
    const key = accessKey.trim();
    if (!address) return defaultConfig;
    let parsed: URL;
    try { parsed = new URL(address); } catch { throw new Error("请输入完整的 HTTPS 答疑库地址。"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash)
        throw new Error("答疑库地址必须使用 HTTPS，不能包含用户名、密码或 # 片段。");
    // The community endpoint uses the plugin login session, never a stored key.
    // Discard old credentials and persist the sanitized configuration on upgrade.
    if (parsed.href === DEFAULT_REMOTE_URL) return defaultConfig;
    if (key && /[^\x21-\x7e]/.test(key)) throw new Error("只读密钥不能包含空格、换行或非 ASCII 字符。");
    return Object.freeze({ url: parsed.href, accessKey: key });
}

export function getRemoteState(): RemoteState { return state; }
export function getRemoteFavoriteScope(): RemoteFavoriteScope | undefined {
    if (!active || !state.ready || state.saving) return;
    if (state.config.url !== DEFAULT_REMOTE_URL) return { libraryUrl: state.config.url, userId: "custom" };
    const session = getContributionState();
    if (!session.user || session.expiresAt <= Date.now() || session.libraryAccess === "denied" || session.libraryAccess === "recheck") return;
    return { libraryUrl: state.config.url, userId: session.user.id };
}
/** Personal stars overlay immutable downloaded entries; cloud edit versions never change. */
export function getPersonalRemoteEntries(): QREntry[] {
    const scope = getRemoteFavoriteScope();
    if (!scope) return emptyEntries;
    return state.entries.map(entry => Object.freeze({ ...entry, favorite: isRemoteFavorite(scope, entry.id) }));
}
function sameScope(scope: RemoteFavoriteScope): boolean {
    const current = getRemoteFavoriteScope();
    return !!current && current.libraryUrl === scope.libraryUrl && current.userId === scope.userId;
}
export async function saveRemoteFavorite(scope: RemoteFavoriteScope, id: string, favorite: boolean): Promise<void> {
    assertActive();
    if (!sameScope(scope) || !state.entries.some(entry => entry.id === id)) throw new Error("云端连接或登录已改变，请重新打开答疑库。");
    await setRemoteFavorite(scope, id, favorite);
}
/** Resolve again at the click, so a menu opened before logout cannot send its old cloud snapshot. */
export async function resolveRemoteEntry(scope: RemoteFavoriteScope, id: string): Promise<QREntry> {
    assertActive();
    const expected = generation;
    if (!sameScope(scope)) throw new Error("云端连接或登录已改变，请重新打开答疑库。");
    if (scope.libraryUrl === DEFAULT_REMOTE_URL && !await getLibrarySessionToken()) throw new Error(LOGIN_HINT);
    if (!active || expected !== generation || !sameScope(scope)) throw new Error("云端连接或登录已改变，请重新打开答疑库。");
    const entry = state.entries.find(entry => entry.id === id);
    if (!entry) throw new Error("这条云端 QR 已不可用，请重新获取答疑库。");
    return Object.freeze({ ...entry, favorite: isRemoteFavorite(scope, id) });
}
export function subscribeRemote(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function startRemoteLibrary(): void {
    if (!active) lifecycle++;
    active = true;
}
export function stopRemoteLibrary(): void {
    active = false;
    lifecycle++;
    generation++;
    request?.controller.abort();
    request = undefined;
    retryAfter = 0;
    loadingConfig = undefined;
    update({ config: defaultConfig, ready: false, saving: false, loading: false, entries: emptyEntries, fetchedAt: null, stale: false, error: "" });
}

/** Forget downloaded community entries (logout / session loss). Config is kept. */
export function clearRemoteCache(): void {
    // A config save or load owns the generation counter; it clears entries itself.
    if (!active || !state.ready || state.saving) return;
    generation++;
    request?.controller.abort();
    request = undefined;
    retryAfter = 0;
    update({ loading: false, entries: emptyEntries, fetchedAt: null, stale: false, error: "" });
}

export function loadRemoteConfig(): Promise<void> {
    assertActive();
    if (state.ready) return Promise.resolve();
    if (loadingConfig) return loadingConfig;
    const expected = generation;
    const task = writingConfig.then(async () => {
        const saved = await DataStore.get<unknown>(CONFIG_KEY);
        const config = saved === undefined ? defaultConfig : validateRemoteConfig(saved);
        if (!active || expected !== generation) return;
        if (saved && typeof saved === "object" && ((saved as RemoteConfig).url !== config.url || (saved as RemoteConfig).accessKey !== config.accessKey))
            await DataStore.set(CONFIG_KEY, config);
        if (active && expected === generation) update({ config, ready: true, error: "" });
    }).catch(() => {
        if (active && expected === generation) update({ ready: true, error: "无法读取云端连接设置，请在高级设置中重新保存。" });
    }).finally(() => { if (loadingConfig === task) loadingConfig = undefined; });
    loadingConfig = task;
    // Also serialize migration writes across stop/start and later user saves.
    writingConfig = task.catch(() => {});
    return task;
}

/** Credentials have their own local key and never enter a QR archive. */
export async function saveRemoteConfig(value: RemoteConfig): Promise<void> {
    const next = validateRemoteConfig(value);
    assertActive();
    const submittedLifecycle = lifecycle;
    await loadRemoteConfig();
    const task = writingConfig.then(async () => {
        assertActive();
        // Stop/restart invalidates queued writes; ordinary sequential saves remain allowed.
        if (submittedLifecycle !== lifecycle) throw new Error("连接设置已失效，请重试。");
        if (next.url === state.config.url && next.accessKey === state.config.accessKey) return;
        const previous = state.config;
        const expected = ++generation;
        request?.controller.abort();
        request = undefined;
        retryAfter = 0;
        update({ config: next, ready: true, saving: true, loading: false, entries: emptyEntries, fetchedAt: null, stale: false, error: "" });
        try {
            await DataStore.set(CONFIG_KEY, next);
        } catch {
            if (active && expected === generation) update({ config: previous, error: "云端连接设置保存失败，已恢复之前的连接设置。" });
            throw new Error("云端连接设置保存失败，请重试。");
        } finally { if (active && expected === generation) update({ saving: false }); }
    });
    writingConfig = task.catch(() => {});
    return task;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("获取已取消。")); };
        promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
    });
}

async function readArchive(response: Response, signal: AbortSignal): Promise<QREntry[]> {
    if (!response.ok) throw new Error(`云端返回 HTTP ${response.status}，请检查地址、权限或只读密钥。`);
    if (response.redirected) throw new Error("答疑库不接受跳转，请填写最终的 HTTPS 地址。");
    if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? ""))
        throw new Error("云端返回的不是 JSON 答疑库，请检查地址。");
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > REMOTE_MAX_BYTES)) throw new Error("云端答疑库超过 32 MiB 下载限制。");
    if (!response.body?.getReader) throw new Error("当前客户端不支持有大小限制的流式下载，请更新客户端。");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parts: string[] = [];
    let bytes = 0;
    let characters = 0;
    try {
        while (true) {
            const { value, done } = await abortable(reader.read(), signal);
            if (signal.aborted) throw new Error("获取已取消。");
            if (done) break;
            bytes += value.byteLength;
            if (bytes > REMOTE_MAX_BYTES) throw new Error("云端答疑库超过 32 MiB 下载限制。");
            const part = decoder.decode(value, { stream: true });
            characters += part.length;
            if (characters > QR_LIMITS.archiveCharacters) throw new Error("云端答疑库文字超过导入限制。");
            parts.push(part);
        }
        parts.push(decoder.decode());
        const json = parts.join("");
        if (json.length > QR_LIMITS.archiveCharacters) throw new Error("云端答疑库文字超过导入限制。");
        const { entries } = parseArchive(json);
        for (const entry of entries) {
            entry.images.forEach(Object.freeze);
            Object.freeze(entry.images);
            Object.freeze(entry.keywords);
            Object.freeze(entry.weakKeywords);
            Object.freeze(entry);
        }
        return Object.freeze(entries) as unknown as QREntry[];
    } finally {
        void reader.cancel().catch(() => {});
        try { reader.releaseLock(); } catch { /* A cancelled reader may still be settling. */ }
    }
}

/** Opening a cloud panel reuses a fresh cache and throttles failed automatic attempts. */
export function ensureRemoteLibrary(): Promise<void> { return fetchRemoteLibrary(false); }
/** Explicit refresh bypasses cache/backoff, but shares any current request. */
export function refreshRemoteLibrary(): Promise<void> { return fetchRemoteLibrary(true); }

async function fetchRemoteLibrary(force: boolean): Promise<void> {
    assertActive();
    const submittedLifecycle = lifecycle;
    await loadRemoteConfig();
    assertActive();
    if (submittedLifecycle !== lifecycle) throw new Error("获取已取消。");
    if (state.saving) {
        if (!force) return;
        throw new Error("请等待连接设置保存完成。");
    }
    if (request) return request.promise;
    if (!force && (Date.now() < retryAfter || (!state.stale && state.fetchedAt !== null && Date.now() - state.fetchedAt < REMOTE_CACHE_MS))) return;
    const { config } = state;
    const expected = generation;
    const controller = new AbortController();
    const operation = { controller, promise: Promise.resolve() };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
    request = operation;
    update({ loading: true, error: "" });
    operation.promise = (async () => {
        try {
            const headers: Record<string, string> = { Accept: "application/json" };
            const community = config.url === DEFAULT_REMOTE_URL;
            if (community) {
                // Role-gated: the server checks the Discord guild role for this session.
                const token = await getLibrarySessionToken();
                if (!token) throw new Error(`社区云端库仅对答疑身份组成员开放。${LOGIN_HINT}`);
                headers.Authorization = `Bearer ${token}`;
            } else if (config.accessKey) headers.Authorization = `Bearer ${config.accessKey}`;
            const response = await abortable(fetch(config.url, {
                method: "GET", headers, signal: controller.signal,
                credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store"
            }).catch(() => { throw new Error("无法连接云端，请检查网络、地址及服务器的跨域配置。"); }), controller.signal);
            if (community && !response.ok) {
                void response.body?.cancel().catch(() => {});
                if (response.status === 401) {
                    await invalidateLibrarySession();
                    if (active && expected === generation) update({ entries: emptyEntries, fetchedAt: null });
                    throw new Error(`登录已过期，或需要重新复查答疑身份组。${LOGIN_HINT}`);
                }
                if (response.status === 403) {
                    if (active && expected === generation) update({ entries: emptyEntries, fetchedAt: null });
                    throw new Error("当前 Discord 账号没有答疑身份组，无法读取社区云端库；本地 QR 不受影响。");
                }
                if (response.status === 429) throw new Error("云端库下载过于频繁，请稍后再试。");
            }
            const entries = await readArchive(response, controller.signal);
            if (!active || expected !== generation || controller.signal.aborted) throw new Error("获取已取消。");
            retryAfter = 0;
            update({ entries, fetchedAt: Date.now(), stale: false, error: "" });
        } catch (error) {
            const message = timedOut ? "获取云端答疑库超时（30 秒），请稍后重试。"
                : error instanceof Error ? error.message : "云端答疑库下载或校验失败。";
            if (active && expected === generation) {
                retryAfter = Date.now() + REMOTE_RETRY_MS;
                update({ stale: state.fetchedAt !== null, error: message });
            }
            throw new Error(message);
        } finally {
            clearTimeout(timer);
            controller.abort();
            if (request === operation) request = undefined;
            if (active && expected === generation) update({ loading: false });
        }
    })();
    return operation.promise;
}

export async function saveRemoteEntryLocally(entry: QREntry): Promise<QREntry> {
    assertActive();
    const copy = validateEntry({ ...entry, id: `remote-copy-${crypto.randomUUID()}`, updatedAt: Date.now() });
    await saveEntry(copy);
    return copy;
}

export function saveRemoteEntriesLocally(entries: QREntry[]): Promise<{ imported: number; skipped: number; }> {
    assertActive();
    return copyEntriesLocally(entries);
}
