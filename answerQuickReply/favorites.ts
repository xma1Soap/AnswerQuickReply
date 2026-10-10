/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

export interface RemoteFavoriteScope { libraryUrl: string; userId: string; }
interface FavoriteReference extends RemoteFavoriteScope { entryId: string; }
const KEY = "AnswerQuickReply_remote_favorites_v1";
const MAX_REFERENCES = 3000;
const listeners = new Set<() => void>();
let references: FavoriteReference[] = [];
let keys = new Set<string>();
let active = false;
let lifecycle = 0;
let loaded = false;
let loading: Promise<void> | undefined;
let writing: Promise<unknown> = Promise.resolve();

function reference(scope: RemoteFavoriteScope, entryId: string): FavoriteReference {
    if (!scope || typeof scope.libraryUrl !== "string" || scope.libraryUrl.length > 4096
        || typeof scope.userId !== "string" || !/^(?:\d{1,22}|custom)$/.test(scope.userId)
        || typeof entryId !== "string" || !/^[\w-]{1,128}$/.test(entryId)) throw new Error("云端收藏引用无效。");
    const url = new URL(scope.libraryUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.href !== scope.libraryUrl)
        throw new Error("云端收藏地址无效。");
    return { libraryUrl: scope.libraryUrl, userId: scope.userId, entryId };
}
function key(value: FavoriteReference): string { return JSON.stringify([value.libraryUrl, value.userId, value.entryId]); }
function check(expected = lifecycle): void {
    if (!active || expected !== lifecycle) throw new Error("云端收藏操作已取消，请重新打开面板。");
}
function update(next: FavoriteReference[]): void {
    references = next;
    keys = new Set(next.map(key));
    for (const listener of listeners) { try { listener(); } catch { /* A view does not control persistence. */ } }
}
function parse(value: unknown): FavoriteReference[] {
    if (value === undefined) return [];
    const archive = value as { version: number; entries: unknown[]; };
    if (!archive || typeof archive !== "object" || Array.isArray(archive)
        || Object.keys(archive).some(k => !["version", "entries"].includes(k)) || archive.version !== 1
        || !Array.isArray(archive.entries) || archive.entries.length > MAX_REFERENCES) throw new Error("云端收藏设置格式不正确。");
    const seen = new Set<string>();
    return archive.entries.map(value => {
        const item = value as FavoriteReference;
        if (!item || typeof item !== "object" || Array.isArray(item)
            || Object.keys(item).some(k => !["libraryUrl", "userId", "entryId"].includes(k))) throw new Error("云端收藏引用格式不正确。");
        return reference(item, item.entryId);
    }).filter(item => { const id = key(item); if (seen.has(id)) return false; seen.add(id); return true; });
}

export function startRemoteFavorites(): void { if (!active) { active = true; lifecycle++; } }
export function stopRemoteFavorites(): void {
    active = false; lifecycle++; loaded = false; loading = undefined;
    update([]);
}
export function subscribeRemoteFavorites(listener: () => void): () => void {
    listeners.add(listener); return () => { listeners.delete(listener); };
}
export function loadRemoteFavorites(): Promise<void> {
    check();
    if (loaded) return Promise.resolve();
    if (loading) return loading;
    const expected = lifecycle;
    const task = writing.then(async () => {
        const saved = await DataStore.get<unknown>(KEY);
        check(expected);
        const next = parse(saved);
        loaded = true; update(next);
    }).finally(() => { if (loading === task) loading = undefined; });
    loading = task;
    return task;
}
export function isRemoteFavorite(scope: RemoteFavoriteScope, entryId: string): boolean {
    return active && loaded && keys.has(key(reference(scope, entryId)));
}
/** Only references are persisted. Downloaded QR text, images and credentials stay out. */
export function setRemoteFavorite(scope: RemoteFavoriteScope, entryId: string, favorite: boolean): Promise<void> {
    check();
    if (typeof favorite !== "boolean") throw new Error("收藏设置无效。");
    const submitted = reference(scope, entryId);
    const expected = lifecycle;
    // Load before joining the write queue, avoiding a load waiting on its own write.
    const ready = loadRemoteFavorites();
    const task = writing.then(async () => {
        await ready; check(expected);
        const id = key(submitted);
        const next = references.filter(item => key(item) !== id);
        if (favorite) next.push(submitted);
        if (next.length > MAX_REFERENCES) throw new Error("云端收藏数量已达到上限，请取消部分收藏。");
        if (keys.has(id) === favorite) return;
        await DataStore.set(KEY, { version: 1, entries: next });
        check(expected); update(next);
    });
    writing = task.catch(() => {});
    return task;
}
