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
const DETAIL_LIMIT = 64 * 1024 * 1024; // An edit detail may contain both bounded old and proposed images.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Server verdict for the community library: open (not gated), ok, denied (no role), recheck (log in again). */
export type LibraryAccess = "" | "open" | "ok" | "denied" | "recheck";
const ACCESS_VALUES: readonly LibraryAccess[] = ["open", "ok", "denied", "recheck"];
interface Session { token: string; expiresAt: number; user: { id: string; username: string; }; canReview: boolean; canAutoPublish: boolean; libraryAccess: LibraryAccess; }
export interface ContributionState { ready: boolean; enabled: boolean; loginUrl: string; user: Session["user"] | null; canReview: boolean; canAutoPublish: boolean; libraryAccess: LibraryAccess; automaticLogin: boolean; autoLoginUrl: string; pairCode: string; loginWaiting: boolean; cloudEditing: boolean; expiresAt: number; }
export interface CloudUpdate { targetId: string; baseUpdatedAt: number; }
export interface Submission { id: string; title: string; status: "pending" | "published" | "rejected"; createdAt: number; updatedAt: number; reason?: string; submitterId?: string; update?: CloudUpdate; }
export interface SubmissionDetail extends Submission { entry: QREntry; current?: QREntry | null; }
let state: ContributionState = { ready: false, enabled: false, loginUrl: "", user: null, canReview: false, canAutoPublish: false, libraryAccess: "", automaticLogin: false, autoLoginUrl: "", pairCode: "", loginWaiting: false, cloudEditing: false, expiresAt: 0 };
interface LoginAttempt { id: string; verifier: string; userId: string; url: string; expires: number; controller: AbortController; polling?: Promise<void>; }
let loginAttempt: LoginAttempt | undefined;
let preparingLogin: Promise<void> | undefined;
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
export function subscribeContributions(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); if (!listeners.size) cancelAutomaticLogin(); }; }
function update(patch: Partial<ContributionState>): void {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) { try { listener(); } catch { /* UI does not control requests. */ } }
}
function check(expected = generation): void { if (!active || expected !== generation) throw new Error("贡献操作已取消，请重新打开面板。"); }
export function startContributions(): void { active = true; }
export function stopContributions(): void {
    cancelAutomaticLogin();
    active = false; generation++; busy = false; loaded = false; loading = undefined; session = null; pending = {};
    controllers.forEach(controller => controller.abort()); controllers.clear();
    update({ ready: false, enabled: false, loginUrl: "", user: null, canReview: false, canAutoPublish: false, libraryAccess: "", automaticLogin: false, autoLoginUrl: "", pairCode: "", loginWaiting: false, cloudEditing: false, expiresAt: 0 });
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
    session = null; update({ user: null, canReview: false, canAutoPublish: false, libraryAccess: "", expiresAt: 0 });
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
        update({ user: session?.user ?? null, canReview: false, canAutoPublish: false, libraryAccess: "", expiresAt: session?.expiresAt ?? 0 });
    }).finally(() => { if (loading === task) loading = undefined; });
    loading = task; writing = task.catch(() => {}); return task;
}
async function responseJson(response: Response, signal: AbortSignal, limit = LIMIT): Promise<any> {
    if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error("贡献服务返回的不是 JSON。");
    if (response.redirected) throw new Error("贡献服务不能重定向请求。");
    if (Number(response.headers.get("content-length") || 0) > limit) throw new Error("贡献响应超过大小上限。");
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
            if (size > limit) throw new Error("贡献响应超过大小上限。");
            text.push(decoder.decode(value, { stream: true }));
        }
        text.push(decoder.decode()); return JSON.parse(text.join(""));
    } finally { signal.removeEventListener("abort", cancel); void reader.cancel().catch(() => {}); }
}
async function api(endpoint: string, body?: unknown, authenticated = true, loginCode?: string, verifier?: string, signal?: AbortSignal): Promise<any> {
    check(); const expected = generation;
    if (authenticated && (!session || session.expiresAt <= Date.now())) { await clearSession(); throw new Error("请先登录贡献服务。"); }
    const token = authenticated ? session!.token : undefined;
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && new TextEncoder().encode(serialized).byteLength > LIMIT) throw new Error("提交内容超过 32 MiB，请减少图片。");
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
        const headers: Record<string, string> = { Accept: "application/json" };
        if (serialized) headers["Content-Type"] = "application/json";
        if (token) headers.Authorization = `Bearer ${token}`;
        if (loginCode) headers.Authorization = `LoginCode ${loginCode}`;
        if (verifier) headers.Authorization = `LoginVerifier ${verifier}`;
        const response = await fetch(COMMUNITY_BASE + endpoint, {
            method: serialized === undefined ? "GET" : "POST", headers, body: serialized, signal: controller.signal,
            credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store"
        });
        check(expected);
        if (authenticated && session?.token !== token) throw new Error("登录身份已改变，请重新操作。");
        if (response.status === 401 && authenticated) { await clearSession(); throw new Error("登录已过期，请重新授权。"); }
        const limit = /^\/contributions\/[0-9a-f-]{36}$/i.test(endpoint) ? DETAIL_LIMIT : LIMIT;
        const result = await responseJson(response, controller.signal, limit); check(expected);
        if (authenticated && session?.token !== token) throw new Error("登录身份已改变，请重新操作。");
        if (!response.ok) throw new Error(typeof result?.message === "string" ? result.message.slice(0, 500) : `贡献服务返回 HTTP ${response.status}`);
        return result;
    } catch (error) {
        if (controller.signal.aborted) throw new Error("贡献请求已取消或超时；提交结果不明时请使用同一条目重试。");
        throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); controllers.delete(controller); }
}
export async function loadContributionPanel(): Promise<void> {
    const expected = generation; await loadLocal(); check(expected);
    const status = await api("/contributions/status", undefined, false);
    if (typeof status?.enabled !== "boolean" || (status.enabled && status.loginUrl !== LOGIN_URL)) throw new Error("贡献服务状态或登录地址不正确。");
    update({ ready: true, enabled: status.enabled, loginUrl: status.enabled ? LOGIN_URL : "", canReview: false, canAutoPublish: false, automaticLogin: status.automaticLogin === true && status.pairing === true, cloudEditing: status.cloudEditing === true });
    if (!state.automaticLogin) cancelAutomaticLogin();
    if (status.enabled && session) {
        const me = await api("/contributions/me");
        try { session = sessionFrom({ ...me, token: session!.token }); }
        catch (error) { await clearSession(); throw error; }
        if (session.libraryAccess === "recheck") {
            await clearSession();
            throw new Error("需要重新用 Discord 登录，以复查答疑身份组。");
        }
        update({ user: session.user, canReview: session.canReview, canAutoPublish: session.canAutoPublish, libraryAccess: session.libraryAccess, expiresAt: session.expiresAt });
    }
}
async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    check(); if (busy) throw new Error("请等待当前贡献操作完成。");
    busy = true; const expected = generation;
    try { const result = await operation(); check(expected); return result; }
    finally { if (expected === generation) busy = false; }
}

export function cancelAutomaticLogin(): void {
    const attempt = loginAttempt;
    loginAttempt = undefined; preparingLogin = undefined;
    attempt?.controller.abort();
    update({ autoLoginUrl: "", pairCode: "", loginWaiting: false });
    if (active && attempt?.id) void api("/auth/auto/cancel", { id: attempt.id }, false, undefined, attempt.verifier).catch(() => {});
}

/** Prepare a normal clickable URL before the click, avoiding popup blockers. */
export async function prepareAutomaticLogin(userId: string | undefined): Promise<void> {
    check();
    if (!state.enabled || !state.automaticLogin || session) return;
    if (!userId || !/^\d{17,20}$/.test(userId)) throw new Error("无法确定当前 Discord 账号，请重新打开登录面板。");
    if (loginAttempt && loginAttempt.userId !== userId) cancelAutomaticLogin();
    if (preparingLogin) return preparingLogin;
    if (loginAttempt && loginAttempt.expires > Date.now() + 30_000) return;
    cancelAutomaticLogin();
    const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const attempt: LoginAttempt = { id: "", verifier, userId, url: "", expires: 0, controller: new AbortController() };
    loginAttempt = attempt;
    const expected = generation;
    const task = (async () => {
        const challenge = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))].map(n => n.toString(16).padStart(2, "0")).join("");
        check(expected);
        if (loginAttempt !== attempt) throw new Error("登录已取消。");
        const result = await api("/auth/auto/start", { challenge, userId, pairing: 1 }, false, undefined, undefined, attempt.controller.signal);
        check(expected);
        if (loginAttempt !== attempt) throw new Error("登录已取消。");
        if (typeof result.id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.id)
            || result.loginUrl !== `${COMMUNITY_BASE}/auth/auto/login/${result.id}`
            || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() || result.expiresAt > Date.now() + 11 * 60_000
            || result.intervalMs !== 5000 || typeof result.pairCode !== "string" || !/^\d{4}$/.test(result.pairCode)) throw new Error("自动登录服务返回了无效信息。");
        Object.assign(attempt, { id: result.id, url: result.loginUrl, expires: result.expiresAt });
        update({ autoLoginUrl: attempt.url, pairCode: result.pairCode });
    })().catch(error => {
        if (loginAttempt === attempt) cancelAutomaticLogin();
        throw error;
    }).finally(() => { if (preparingLogin === task) preparingLogin = undefined; });
    preparingLogin = task;
    return task;
}

function loginDelay(signal: AbortSignal, ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("登录已取消。")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
    });
}

export async function waitForAutomaticLogin(currentUserId: () => string | undefined): Promise<void> {
    const attempt = loginAttempt;
    if (!attempt?.id || attempt.expires <= Date.now()) { cancelAutomaticLogin(); throw new Error("登录链接已过期，请重新准备登录。"); }
    if (attempt.polling) return attempt.polling;
    const expected = generation;
    const valid = () => {
        check(expected);
        if (loginAttempt !== attempt || attempt.controller.signal.aborted) throw new Error("登录已取消。");
        if (currentUserId() !== attempt.userId) throw new Error("Discord 账号已切换，请重新登录。");
        if (Date.now() >= attempt.expires) throw new Error("等待授权已超时，请重新登录。");
    };
    update({ loginWaiting: true });
    const task = (async () => {
        let failures = 0;
        while (true) {
            valid();
            await loginDelay(attempt.controller.signal, 5000 * (failures + 1));
            valid();
            let result;
            try { result = await api("/auth/auto/poll", { id: attempt.id }, false, undefined, attempt.verifier, attempt.controller.signal); }
            catch (error) { valid(); if (++failures >= 3) throw error; continue; }
            valid(); failures = 0;
            if (result.status === "pending") continue;
            if (result.status === "failed") throw new Error(typeof result.message === "string" ? result.message.slice(0, 500) : "授权未完成，请重新登录。");
            if (result.status !== "complete") throw new Error("自动登录返回了无效状态。");
            const next = sessionFrom(result);
            if (next.user.id !== attempt.userId || !["ok", "open"].includes(next.libraryAccess)) throw new Error("授权账号或答疑权限与本次请求不符。");
            // Serialize the validity checks with storage. A late HTTP response
            // or a plugin stop/account switch must not persist a stale login.
            const persist = writing.then(async () => {
                valid();
                await DataStore.set(SESSION_KEY, next);
                try { valid(); } catch (error) { await DataStore.set(SESSION_KEY, null); throw error; }
            });
            writing = persist.catch(() => {});
            await persist; valid(); session = next;
            loginAttempt = undefined;
            update({ user: next.user, canReview: next.canReview, canAutoPublish: next.canAutoPublish, libraryAccess: next.libraryAccess, expiresAt: next.expiresAt, autoLoginUrl: "", pairCode: "", loginWaiting: false });
            if (getRemoteState().config.url === DEFAULT_REMOTE_URL) void refreshRemoteLibrary().catch(() => {});
            return;
        }
    })().finally(() => { if (loginAttempt === attempt) cancelAutomaticLogin(); });
    attempt.polling = task;
    return task;
}

export async function exchangeLoginCode(code: string): Promise<void> {
    cancelAutomaticLogin();
    return exclusive(async () => {
        if (!state.enabled) throw new Error("管理员尚未开通提交。");
        const clean = code.trim(); if (!/^[\x21-\x7e]{1,256}$/.test(clean)) throw new Error("请输入有效的一次性登录码。");
        const next = sessionFrom(await api("/auth/exchange", {}, false, clean));
        const expected = generation; await write(SESSION_KEY, next); check(expected); session = next;
        update({ user: next.user, canReview: next.canReview, canAutoPublish: next.canAutoPublish, libraryAccess: next.libraryAccess, expiresAt: next.expiresAt });
        if (getRemoteState().config.url === DEFAULT_REMOTE_URL) void refreshRemoteLibrary().catch(() => {});
    });
}
export async function logoutContributions(): Promise<void> {
    cancelAutomaticLogin();
    return exclusive(async () => {
        const expected = generation;
        try { if (session) await api("/auth/logout", {}); }
        finally { if (active && expected === generation) await clearSession(); }
    });
}
export async function logoutAllContributions(): Promise<void> {
    cancelAutomaticLogin();
    return exclusive(async () => {
        // Keep the session on network failure so the user can retry global revocation.
        // A 401 still clears the expired local session through api().
        if (session) await api("/auth/logout-all", {});
        await clearSession();
    });
}
export function snapshotContribution(entry: QREntry): QREntry {
    const result = validateEntry(JSON.parse(JSON.stringify(entry)));
    result.images.forEach(Object.freeze); Object.freeze(result.images); Object.freeze(result.keywords); Object.freeze(result.weakKeywords);
    return Object.freeze(result);
}
function cloudUpdate(value: CloudUpdate): CloudUpdate {
    if (!value || typeof value.targetId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.targetId)
        || !Number.isSafeInteger(value.baseUpdatedAt) || value.baseUpdatedAt < 0 || value.baseUpdatedAt >= Number.MAX_SAFE_INTEGER) throw new Error("云端编辑目标或版本无效。");
    return Object.freeze({ targetId: value.targetId, baseUpdatedAt: value.baseUpdatedAt });
}
function summary(value: any): Submission {
    if (!value || typeof value.id !== "string" || !uuid.test(value.id) || typeof value.title !== "string" || value.title.length > 120
        || !["pending", "published", "rejected"].includes(value.status) || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)
        || (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 500))) throw new Error("提交记录格式不正确。");
    return { id: value.id, title: value.title, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt, reason: value.reason, submitterId: value.submitterId, update: value.update === undefined ? undefined : cloudUpdate(value.update) };
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
    const current = state.canReview && record.update && result.submission.current !== undefined
        ? result.submission.current === null ? null : snapshotContribution(result.submission.current) : undefined;
    if (current && current.id !== record.update!.targetId) throw new Error("当前云端版本与修改目标不匹配。");
    return { ...record, entry: snapshotContribution(result.submission.entry), ...(current === undefined ? {} : { current }) };
}
export async function submitContribution(entry: QREntry, update?: CloudUpdate): Promise<{ id: string; status: "pending" | "published"; }> {
    const snapshot = snapshotContribution(entry);
    const replacement = update === undefined ? undefined : cloudUpdate(update);
    if (replacement && snapshot.id !== replacement.targetId) throw new Error("编辑内容与云端条目 ID 不匹配。");
    return exclusive(async () => {
        if (!state.enabled) throw new Error("管理员尚未开通提交。");
        if (!session) throw new Error("请先登录贡献服务。");
        if (replacement && (!state.cloudEditing || getRemoteState().config.url !== DEFAULT_REMOTE_URL)) throw new Error("当前云端服务不支持直接编辑，请更新服务或切回社区云端。");
        const expected = generation;
        const bytes = new TextEncoder().encode(JSON.stringify({ user: session.user.id, entry: snapshot, ...(replacement ? { update: replacement } : {}) }));
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join("");
        check(expected);
        const requestId = pending[digest] ?? crypto.randomUUID();
        const reserved = { ...pending, [digest]: requestId };
        await write(PENDING_KEY, reserved); check(expected); pending = reserved;
        const result = await api("/contributions", { entry: snapshot, requestId, ...(replacement ? { update: replacement } : {}) });
        if (!uuid.test(result?.id) || !["pending", "published"].includes(result?.status)) throw new Error("提交返回结果不正确，请重试确认。");
        const confirmed = { ...pending }; delete confirmed[digest];
        await write(PENDING_KEY, confirmed); check(expected); pending = confirmed;
        if (result.status === "published" && getRemoteState().config.url === DEFAULT_REMOTE_URL) {
            clearRemoteCache(); // Cancel reads started before publication; never reuse a stale in-flight response.
            void refreshRemoteLibrary().catch(() => {});
        }
        return { id: result.id, status: result.status };
    });
}
export async function reviewSubmission(id: string, decision: "approve" | "reject", reason = ""): Promise<string> {
    return exclusive(async () => {
        if (!state.canReview) throw new Error("服务未授予审核权限。");
        if (!uuid.test(id) || !["approve", "reject"].includes(decision) || reason.length > 500) throw new Error("审核参数不正确。");
        const result = await api(`/contributions/${id}/review`, { decision, reason: reason.trim() });
        if (result?.id !== id || !["published", "rejected"].includes(result?.status)) throw new Error("审核返回结果不正确，请刷新列表确认。");
        if (result.status === "published" && getRemoteState().config.url === DEFAULT_REMOTE_URL) {
            clearRemoteCache();
            void refreshRemoteLibrary().catch(() => {});
        }
        return result.status;
    });
}
