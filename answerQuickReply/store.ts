/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

import { parseArchive, QRArchive, QREntry, serializeArchive, validateArchive, validateEntry } from "./model";

const STORAGE_KEY = "AnswerQuickReply_library_v1";
const BUILTIN_CLEANUP_KEY = "AnswerQuickReply_builtin_cleanup_v1";
const listeners = new Set<() => void>();
let entries: QREntry[] = [];
let loaded = false;
let loading: Promise<void> | undefined;
let writing: Promise<unknown> = Promise.resolve();

function notify() {
    for (const listener of listeners) {
        try { listener(); } catch (error) { console.error("[AnswerQuickReply] Library listener failed", error); }
    }
}

function freezeEntries(next: QREntry[]): QREntry[] {
    // A shared snapshot stays stable for React subscriptions. Callers cannot
    // mutate the live data behind persistence; edits must go through saveEntry.
    for (const entry of next) {
        entry.images.forEach(Object.freeze);
        Object.freeze(entry.images);
        Object.freeze(entry.keywords);
        Object.freeze(entry.weakKeywords);
        Object.freeze(entry);
    }
    return Object.freeze(next) as unknown as QREntry[];
}

function isUnmodifiedBuiltin(entry: QREntry): boolean {
    // Recognize the retired example only for the one-time cleanup. Edited QR
    // entries belong to the user; changing only the favorite flag is harmless.
    return entry.id === "starter-network-streaming"
        && entry.title === "网络与流式通用排查"
        && entry.content === "打开流式\n开关梯子，换节点"
        && JSON.stringify(entry.keywords) === JSON.stringify(["524", "errorcode_524", "A timeout occurred"])
        && JSON.stringify(entry.weakKeywords) === JSON.stringify(["cloudflare", "超时"])
        && entry.images.length === 0 && entry.sourceUrl === undefined;
}

export function loadLibrary(): Promise<void> {
    if (loaded) return Promise.resolve();
    if (loading) return loading;
    loading = (async () => {
        const saved = await DataStore.get<unknown>(STORAGE_KEY);
        let archive: QRArchive = saved === undefined ? { version: 1, entries: [] } : validateArchive(saved);
        const cleaned = await DataStore.get(BUILTIN_CLEANUP_KEY) === true;
        let removedBuiltin = false;
        if (!cleaned) {
            const remaining = archive.entries.filter(entry => !isUnmodifiedBuiltin(entry));
            removedBuiltin = remaining.length !== archive.entries.length;
            if (removedBuiltin) archive = { version: 1, entries: remaining };
        }
        if (saved === undefined || removedBuiltin) await DataStore.set(STORAGE_KEY, archive);
        // Mark only after the library write succeeds, so interrupted cleanup can
        // retry. Explicitly imported entries are left alone after this migration.
        if (!cleaned) await DataStore.set(BUILTIN_CLEANUP_KEY, true);
        entries = freezeEntries(archive.entries);
        loaded = true;
        notify();
    })().finally(() => { loading = undefined; });
    return loading;
}

export function getEntries(): QREntry[] {
    return entries;
}

export function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = writing.then(async () => {
        await loadLibrary();
        return operation();
    });
    // A failed write is returned to its caller without blocking later writes.
    writing = result.catch(() => {});
    return result;
}

async function persist(next: QREntry[]): Promise<void> {
    const archive = validateArchive({ version: 1, entries: next });
    await DataStore.set(STORAGE_KEY, archive);
    entries = freezeEntries(archive.entries);
    notify();
}

export async function saveEntry(entry: QREntry): Promise<void> {
    const copy = validateEntry(entry);
    return enqueue(async () => {
        const next = entries.filter(existing => existing.id !== copy.id);
        next.push(copy);
        await persist(next);
    });
}

export function deleteEntry(id: string): Promise<void> {
    return enqueue(async () => {
        if (entries.some(entry => entry.id === id)) await persist(entries.filter(entry => entry.id !== id));
    });
}

export function exportLibrary(): string {
    if (!loaded) throw new Error("答疑库尚未加载完成。");
    return serializeArchive(entries);
}

export async function importLibrary(json: string): Promise<number> {
    const imported = parseArchive(json);
    return enqueue(async () => {
        const merged = new Map(entries.map(entry => [entry.id, entry]));
        for (const entry of imported.entries) merged.set(entry.id, entry);
        await persist([...merged.values()]);
        return imported.entries.length;
    });
}

/** Copy a cloud selection in one write; never replace an existing local entry. */
export async function copyEntriesLocally(selection: QREntry[]): Promise<{ imported: number; skipped: number; }> {
    const copies = validateArchive({ version: 1, entries: selection }).entries;
    // IDs, favorites and edit timestamps are local metadata, not reply content.
    const contentKey = (entry: QREntry) => JSON.stringify([
        entry.title, entry.content, entry.keywords, entry.weakKeywords,
        entry.images.map(image => [image.name, image.dataUrl]), entry.sourceUrl ?? ""
    ]);
    return enqueue(async () => {
        const seen = new Set(entries.map(contentKey));
        const added: QREntry[] = [];
        for (const entry of copies) {
            const key = contentKey(entry);
            if (seen.has(key)) continue;
            seen.add(key);
            added.push({ ...entry, id: `remote-copy-${crypto.randomUUID()}`, updatedAt: Date.now() });
        }
        // Validate capacity and all image data before committing any of the batch.
        if (added.length) await persist([...entries, ...added]);
        return { imported: added.length, skipped: copies.length - added.length };
    });
}
