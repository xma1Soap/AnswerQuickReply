/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

import { QREntry, validateEntry } from "./model";
import { clearRemoteCache, DEFAULT_REMOTE_URL, getRemoteState, refreshRemoteLibrary } from "./remote";

export const COMMUNITY_BASE = "https://api.starmint.cc.cd/answer-qr";
const LOGIN_URL = `${COMMUNITY_BASE}/auth/login`;
const SESSION_KEY = "AnswerQuickReply_contribution_session_v1";
const PENDING_KEY = "AnswerQuickReply_contribution_pending_v1";
const LIMIT = 32 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Server verdict for the community library: open (not gated), ok, denied (no role), recheck (log in again). */
export type LibraryAccess = "" | "open" | "ok" | "denied" | "recheck";
const ACCESS_VALUES: readonly LibraryAccess[] = ["open", "ok", "denied", "recheck"];
interface Session { token: string; expiresAt: number; user: { id: string; username: string; }; canReview: boolean; canAutoPublish: boolean; libraryAccess: LibraryAccess; }
export interface ContributionState { ready: boolean; enabled: boolean; loginUrl: string; user: Session["user"] | null; canReview: boolean; canAutoPublish: boolean; libraryAccess: LibraryAccess; }
export interface Submission { id: string; title: string; status: "pending" | "published" | "rejected"; createdAt: number; updatedAt: number; reason?: string; submitterId?: string; }
export interface SubmissionDetail extends Submission { entry: QREntry; }
let state: ContributionState = { ready: false, enabled: false, loginUrl: "", user: null, canReview: false, canAutoPublish: false, libraryAccess: "" };
let session: Session | null = null;
let pending: Record<string, string> = {};
let active = false;
let generation = 0;
let loaded = false;
let loading: Promise<void> | undefined;
let writing: Promise<unknown> = Promise.resolve();
let busy = false;
const controllers = new Set<AbortController>();
const listeners = new Set<() => void>();

export function getContributionState(): ContributionState { return state; }
export function subscribeContributions(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
function update(patch: Partial<ContributionState>): void {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) { try { listener(); } catch { /* UI does not control requests. */ } }
}
function check(expected = generation): void { if (!active || expected !== generation) throw new Error("贡献操作已取消，请重新打开面板。"); }
export function startContributions(): void { active = true; }
export function stopContributions(): void {
    active = false; generation++; busy = false; loaded = false; loading = undefined; session = null; pending = {};
    controllers.forEach(controller => controller.abort()); controllers.clear();
    update({ ready: false, enabled: false, loginUrl: "", user: null, canReview: false, canAutoPublish: false, libraryAccess: "" });
}
function sessionFrom(value: unknown): Session {
    const s = value as Session;
    if (!s || typeof s.token !== "string" || !/^[\x21-\x7e]{16,4096}$/.test(s.token) || !Number.isFinite(s.expiresAt) || s.expiresAt <= Date.now()
        || !s.user || !/^\d{1,22}$/.test(s.user.id) || typeof s.user.username !== "string" || s.user.username.length > 100
        || typeof s.canReview !== "boolean" || typeof s.canAutoPublish !== "boolean") throw new Error("登录已失效，请重新授权。");
    const libraryAccess = ACCESS_VALUES.includes(s.libraryAccess) ? s.libraryAccess : "";
    return Object.freeze({ token: s.token, expiresAt: s.expiresAt, user: Object.freeze({ id: s.user.id, username: s.user.username }), canReview: s.canReview, canAutoPublish: s.canAutoPublish, libraryAccess });
}
function write(key: string, value: unknown): Promise<void> {
    const task = writing.then(() => DataStore.set(key, value));
    writing = task.catch(() => {});
    return task;
}
async function clearSession(clearLibrary = true): Promise<void> {
    session = null; update({ user: null, canReview: false, canAutoPublish: false, libraryAccess: "" });
    // The community library is only readable while logged in; drop its cached copy too.
    if (clearLibrary) clearRemoteCache();
    await write(SESSION_KEY, null);
}
/** Session token for the role-gated community library, or null when not logged in. */
export async function getLibrarySessionToken(): Promise<string | null> {
    if (!active) return null;
    await loadLocal();
    return session && session.expiresAt > Date.now() ? session.token : null;
}
/** The library rejected the session (expired, or the role must be re-verified). */
export async function invalidateLibrarySession(): Promise<void> {
    if (active && session) await clearSession(false);
}
async function loadLocal(): Promise<void> {
    check();
    if (loaded) return;
    if (loading) return loading;
    const expected = generation;
    const task = writing.then(async () => {
        const [saved, attempts] = await Promise.all([DataStore.get(SESSION_KEY), DataStore.get(PENDING_KEY)]);
        check(expected);
        try { session = saved ? sessionFrom(saved) : null; } catch { session = null; await DataStore.set(SESSION_KEY, null); }
        check(expected);
        pending = {};
        if (attempts && typeof attempts === "object") for (const [key, value] of Object.entries(attempts))
            if (/^[a-f0-9]{64}$/.test(key) && typeof value === "string" && uuid.test(value)) pending[key] = value;
        loaded = true;
        // Capabilities are deliberately not trusted from local storage. /me
        // must confirm them whenever the contribution panel is opened.
        update({ user: session?.user ?? null, canReview: false, canAutoPublish: false, libraryAccess: "" });
    }).finally(() => { if (loading === task) loading = undefined; });
    loading = task; writing = task.catch(() => {}); return task;
}
async function responseJson(response: Response, signal: AbortSignal): Promise<any> {
    if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error("贡献服务返回的不是 JSON。");
    if (response.redirected) throw new Error("贡献服务不能重定向请求。");
    if (Number(response.headers.get("content-length") || 0) > LIMIT) throw new Error("贡献响应超过 32 MiB。");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("客户端不支持贡献服务所需的流式读取。");
    let size = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const text: string[] = [];
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (signal.aborted) throw new Error("贡献请求已取消或超时。");
            if (done) break;
            size += value.byteLength;
            if (size > LIMIT) throw new Error("贡献响应超过 32 MiB。");
            text.push(decoder.decode(value, { stream: true }));
        }
        text.push(decoder.decode()); return JSON.parse(text.join(""));
    } finally { signal.removeEventListener("abort", cancel); void reader.cancel().catch(() => {}); }
}
async function api(endpoint: string, body?: unknown, authenticated = true, loginCode?: string): Promise<any> {
    check(); const expected = generation;
    if (authenticated && (!session || session.expiresAt <= Date.now())) { await clearSession(); throw new Error("请先登录贡献服务。"); }
    const token = authenticated ? session!.token : undefined;
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && new TextEncoder().encode(serialized).byteLength > LIMIT) throw new Error("提交内容超过 32 MiB，请减少图片。");
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
        const headers: Record<string, string> = { Accept: "application/json" };
        if (serialized) headers["Content-Type"] = "application/json";
        if (token) headers.Authorization = `Bearer ${token}`;
        if (loginCode) headers.Authorization = `LoginCode ${loginCode}`;
        const response = await fetch(COMMUNITY_BASE + endpoint, {
            method: serialized === undefined ? "GET" : "POST", headers, body: serialized, signal: controller.signal,
            credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store"
        });
        check(expected);
        if (authenticated && session?.token !== token) throw new Error("登录身份已改变，请重新操作。");
        if (response.status === 401) { await clearSession(); throw new Error("登录已过期，请重新授权。"); }
        const result = await responseJson(response, controller.signal); check(expected);
        if (authenticated && session?.token !== token) throw new Error("登录身份已改变，请重新操作。");
        if (!response.ok) throw new Error(typeof result?.message === "string" ? result.message.slice(0, 500) : `贡献服务返回 HTTP ${response.status}`);
        return result;
    } catch (error) {
        if (controller.signal.aborted) throw new Error("贡献请求已取消或超时；提交结果不明时请使用同一条目重试。");
        throw error;
    } finally { clearTimeout(timer); controllers.delete(controller); }
}
export async function loadContributionPanel(): Promise<void> {
    const expected = generation; await loadLocal(); check(expected);
    const status = await api("/contributions/status", undefined, false);
    if (typeof status?.enabled !== "boolean" || (status.enabled && status.loginUrl !== LOGIN_URL)) throw new Error("贡献服务状态或登录地址不正确。");
    update({ ready: true, enabled: status.enabled, loginUrl: status.enabled ? LOGIN_URL : "", canReview: false, canAutoPublish: false });
    if (status.enabled && session) {
        const me = await api("/contributions/me");
        try { session = sessionFrom({ ...me, token: session!.token }); }
        catch (error) { await clearSession(); throw error; }
        if (session.libraryAccess === "recheck") {
            await clearSession();
            throw new Error("需要重新用 Discord 登录，以复查答疑身份组。");
        }
        update({ user: session.user, canReview: session.canReview, canAutoPublish: session.canAutoPublish, libraryAccess: session.libraryAccess });
    }
}
async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    check(); if (busy) throw new Error("请等待当前贡献操作完成。");
    busy = true; const expected = generation;
    try { const result = await operation(); check(expected); return result; }
    finally { if (expected === generation) busy = false; }
}
export async function exchangeLoginCode(code: string): Promise<void> {
    return exclusive(async () => {
        if (!state.enabled) throw new Error("管理员尚未开通提交。");
        const clean = code.trim(); if (!/^[\x21-\x7e]{1,256}$/.test(clean)) throw new Error("请输入有效的一次性登录码。");
        const next = sessionFrom(await api("/auth/exchange", {}, false, clean));
        const expected = generation; await write(SESSION_KEY, next); check(expected); session = next;
        update({ user: next.user, canReview: next.canReview, canAutoPublish: next.canAutoPublish, libraryAccess: next.libraryAccess });
        if (getRemoteState().config.url === DEFAULT_REMOTE_URL) void refreshRemoteLibrary().catch(() => {});
    });
}
export async function logoutContributions(): Promise<void> {
    return exclusive(async () => {
        const expected = generation;
        try { if (session) await api("/auth/logout", {}); }
        finally { if (active && expected === generation) await clearSession(); }
    });
}
export function snapshotContribution(entry: QREntry): QREntry {
    const result = validateEntry(JSON.parse(JSON.stringify(entry)));
    result.images.forEach(Object.freeze); Object.freeze(result.images); Object.freeze(result.keywords); Object.freeze(result.weakKeywords);
    return Object.freeze(result);
}
function summary(value: any): Submission {
    if (!value || typeof value.id !== "string" || !uuid.test(value.id) || typeof value.title !== "string" || value.title.length > 120
        || !["pending", "published", "rejected"].includes(value.status) || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)
        || (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 500))) throw new Error("提交记录格式不正确。");
    return { id: value.id, title: value.title, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt, reason: value.reason, submitterId: value.submitterId };
}
export async function listSubmissions(review = false): Promise<Submission[]> {
    if (review && !state.canReview) throw new Error("服务未授予审核权限。");
    const result = await api(`/contributions/${review ? "pending" : "mine"}`);
    if (!Array.isArray(result?.submissions) || result.submissions.length > 100) throw new Error("提交列表格式不正确。");
    return result.submissions.map(summary);
}
export async function readSubmission(id: string): Promise<SubmissionDetail> {
    if (!uuid.test(id)) throw new Error("提交 ID 不正确。");
    const result = await api(`/contributions/${id}`);
    const record = summary(result?.submission);
    if (record.id !== id) throw new Error("提交详情 ID 不匹配。");
    return { ...record, entry: snapshotContribution(result.submission.entry) };
}
export async function submitContribution(entry: QREntry): Promise<{ id: string; status: "pending" | "published"; }> {
    const snapshot = snapshotContribution(entry);
    return exclusive(async () => {
        if (!state.enabled) throw new Error("管理员尚未开通提交。");
        if (!session) throw new Error("请先登录贡献服务。");
        const expected = generation;
        const bytes = new TextEncoder().encode(JSON.stringify({ user: session.user.id, entry: snapshot }));
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join("");
        check(expected);
        const requestId = pending[digest] ?? crypto.randomUUID();
        const reserved = { ...pending, [digest]: requestId };
        await write(PENDING_KEY, reserved); check(expected); pending = reserved;
        const result = await api("/contributions", { entry: snapshot, requestId });
        if (!uuid.test(result?.id) || !["pending", "published"].includes(result?.status)) throw new Error("提交返回结果不正确，请重试确认。");
        const confirmed = { ...pending }; delete confirmed[digest];
        await write(PENDING_KEY, confirmed); check(expected); pending = confirmed;
        if (result.status === "published" && getRemoteState().config.url === DEFAULT_REMOTE_URL) void refreshRemoteLibrary().catch(() => {});
        return { id: result.id, status: result.status };
    });
}
export async function reviewSubmission(id: string, decision: "approve" | "reject", reason = ""): Promise<string> {
    return exclusive(async () => {
        if (!state.canReview) throw new Error("服务未授予审核权限。");
        if (!uuid.test(id) || !["approve", "reject"].includes(decision) || reason.length > 500) throw new Error("审核参数不正确。");
        const result = await api(`/contributions/${id}/review`, { decision, reason: reason.trim() });
        if (result?.id !== id || !["published", "rejected"].includes(result?.status)) throw new Error("审核返回结果不正确，请刷新列表确认。");
        if (result.status === "published" && getRemoteState().config.url === DEFAULT_REMOTE_URL) void refreshRemoteLibrary().catch(() => {});
        return result.status;
    });
}
