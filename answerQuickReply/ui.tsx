/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Message, MessageAttachment, RenderModalProps } from "@vencord/discord-types";
import { ChannelStore, closeAllModals, ConfirmModal, MessageActions, Modal, NavigationRouter, openModal, Parser, SelectedChannelStore, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "@webpack/common";

import { errorText, fileToImage, imageAttachments, imageTools, recognizeAttachment } from "./bridge";
import { openContributions } from "./contributeUi";
import { Icon, IconName } from "./icons";
import { matchEntries, normalizeText, QR_LIMITS, QREntry, QRImage, QRMatch, searchEntries } from "./model";
import { showQrToast } from "./notify";
import { DEFAULT_REMOTE_URL, ensureRemoteLibrary, getRemoteState, loadRemoteConfig, refreshRemoteLibrary, saveRemoteConfig, saveRemoteEntriesLocally, saveRemoteEntryLocally, subscribeRemote } from "./remote";
import { sendReply } from "./send";
import { settings } from "./settings";
import { deleteEntry, exportLibrary, getEntries, importLibrary, loadLibrary, saveEntry, subscribe } from "./store";
import { ReplyTarget, snapshotReplyTarget } from "./target";

/* ───────────────────────────── helpers ───────────────────────────── */

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");
const cssVars = (vars: Record<string, string | number>) => vars as React.CSSProperties;

/** Chinese IME confirms candidates with Enter; that keypress must never send or commit. */
const isComposing = (e: React.KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

function prefersReducedMotion() {
    try {
        return document.documentElement.classList.contains("reduce-motion")
            || matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch { return false; }
}

function relativeTime(timestamp: number) {
    const diff = Date.now() - timestamp;
    const minute = 60_000, hour = 60 * minute, day = 24 * hour;
    if (diff < minute) return "刚刚";
    if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
    if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
    return new Date(timestamp).toLocaleDateString("zh-CN");
}

function authorName(message: ReplyTarget) {
    return message.author?.globalName || message.author?.username || "这条消息";
}

function thumbnailOf(attachment: MessageAttachment) {
    const url = attachment.proxy_url || attachment.url;
    return `${url}${url.includes("?") ? "&" : "?"}width=96&height=96`;
}

function openSourceMessage(sourceUrl: string) {
    try {
        const url = new URL(sourceUrl);
        const match = /^\/channels\/(@me|\d+)\/(\d+)\/(\d+)\/?$/.exec(url.pathname);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password
            || !/^(?:(?:canary|ptb)\.)?discord(?:app)?\.com$/.test(url.hostname) || !match)
            throw new Error("收录来源不是有效的 Discord 消息链接。");

        const [, guildId, channelId, messageId] = match;
        if (SelectedChannelStore.getChannelId() === channelId)
            MessageActions.jumpToMessage({ channelId, messageId, flash: true, jumpType: "INSTANT" });
        else
            NavigationRouter.transitionTo(`/channels/${guildId}/${channelId}/${messageId}`);
        closeAllModals();
    } catch (error) {
        showQrToast(`无法跳转到原消息：${errorText(error)}`, "failure");
    }
}

/** One-line plain preview for list rows; the detail pane shows the real Markdown. */
function plainPreview(entry: QREntry) {
    const line = entry.content.split("\n").map(l => l.trim()).find(Boolean) ?? "";
    const plain = line.replace(/(\*\*|__|~~|\|\||`+)/g, "").replace(/^(#{1,3}|>|-|\*)\s+/, "").replace(/<a?:(\w+):\d+>/g, ":$1:");
    return plain || (entry.images.length ? "图片答复" : "");
}

function splitKeywords(value: string) {
    return [...new Set(value.split(/[\n,，;；]/).map(v => v.trim()).filter(Boolean))];
}

function mergeKeywords(values: string[], pending: string) {
    const seen = new Set<string>();
    return [...values, ...splitKeywords(pending)].filter(value => {
        const key = normalizeText(value);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

const byFavoriteThenRecent = (a: QREntry, b: QREntry) => Number(b.favorite) - Number(a.favorite) || b.updatedAt - a.updatedAt;

/**
 * Keeps an element mounted for its exit transition, then runs `done`.
 * The caller handles errors inside `done`; a failed removal simply animates back in.
 */
function useExit(duration: number) {
    const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
    const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    useEffect(() => () => timers.current.forEach(clearTimeout), []);
    const exit = useCallback((key: string, done: () => unknown) => {
        if (timers.current.has(key)) return;
        setLeaving(prev => new Set(prev).add(key));
        timers.current.set(key, setTimeout(async () => {
            try { await done(); } finally {
                timers.current.delete(key);
                setLeaving(prev => {
                    const next = new Set(prev);
                    next.delete(key);
                    return next;
                });
            }
        }, prefersReducedMotion() ? 0 : duration));
    }, [duration]);
    return [leaving, exit] as const;
}

function useLibrary() {
    const [entries, setEntries] = useState(getEntries);
    const [error, setError] = useState("");
    useEffect(() => {
        const unsubscribe = subscribe(() => setEntries([...getEntries()]));
        loadLibrary().then(() => setEntries([...getEntries()])).catch(e => setError(errorText(e)));
        return unsubscribe;
    }, []);
    return { entries, error };
}

function useRemoteLibrary() {
    const [remote, setRemote] = useState(getRemoteState);
    useEffect(() => {
        const unsubscribe = subscribeRemote(() => setRemote(getRemoteState()));
        loadRemoteConfig().catch(() => {});
        return unsubscribe;
    }, []);
    return remote;
}

/* ─────────────────────────── primitives ─────────────────────────── */

type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
    variant?: "primary" | "soft" | "ghost" | "danger";
    size?: "sm" | "md";
    icon?: IconName;
    iconFilled?: boolean;
    loading?: boolean;
};

function Button({ variant = "soft", size = "md", icon, iconFilled, loading, className, children, disabled, ...rest }: ButtonProps) {
    return <button
        type="button"
        {...rest}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={cx("aqr-btn", `aqr-btn--${variant}`, size === "sm" && "aqr-btn--sm", !children && "aqr-btn--icon", loading && "is-loading", className)}
    >
        {loading ? <span className="aqr-spinner" aria-hidden="true" /> : icon && <Icon name={icon} filled={iconFilled} />}
        {children != null && children !== false && <span className="aqr-btn-label">{children}</span>}
    </button>;
}

function Switch({ checked, onChange, label, hint, icon }: { checked: boolean; onChange(value: boolean): void; label: string; hint?: string; icon?: IconName; }) {
    // mousedown is prevented so toggling keeps focus where it was (e.g. the search box, for Enter-to-send).
    return <label className={cx("aqr-switch", checked && "is-on")} onMouseDown={e => e.preventDefault()}>
        <input type="checkbox" role="switch" checked={checked} onChange={e => onChange(e.currentTarget.checked)} />
        <span className="aqr-switch-track" aria-hidden="true"><span className="aqr-switch-thumb" /></span>
        <span className="aqr-switch-text">
            <span className="aqr-switch-label">{icon && <Icon name={icon} size={14} />}{label}</span>
            {hint && <small>{hint}</small>}
        </span>
    </label>;
}

function Banner({ tone, children, onDismiss }: { tone: "danger" | "info" | "positive"; children: React.ReactNode; onDismiss?(): void; }) {
    return <div role={tone === "danger" ? "alert" : "status"} className={cx("aqr-banner", `is-${tone}`)}>
        <Icon name={tone === "danger" ? "x" : tone === "positive" ? "check" : "spark"} size={15} className="aqr-banner-icon" />
        <span className="aqr-banner-text">{children}</span>
        {onDismiss && <button type="button" className="aqr-banner-close" aria-label="关闭提示" onClick={onDismiss}><Icon name="x" size={14} /></button>}
    </div>;
}

function Collapse({ open, children }: { open: boolean; children: React.ReactNode; }) {
    return <div className={cx("aqr-collapse", open && "is-open")} aria-hidden={!open}>
        <div className="aqr-collapse-inner">{children}</div>
    </div>;
}

function RemoteConnection() {
    const remote = useRemoteLibrary();
    const [url, setUrl] = useState(remote.config.url);
    const [accessKey, setAccessKey] = useState(remote.config.accessKey);
    const [status, setStatus] = useState("");
    const [error, setError] = useState("");
    useEffect(() => {
        setUrl(remote.config.url);
        setAccessKey(remote.config.accessKey);
    }, [remote.config]);
    const isDefault = !url.trim() || url.trim() === DEFAULT_REMOTE_URL;
    return <section className="aqr-remote-connection" aria-label="云端答疑库高级设置">
        <strong>云端答疑库 · 高级设置</strong>
        <p>默认社区云端需要用拥有答疑身份组的 Discord 账号登录。也可改用自己的 HTTPS JSON 地址；打开云端面板时获取，不会上传或同步本地 QR。</p>
        <label>答疑库地址<input type="url" autoComplete="off" spellCheck={false} placeholder="https://example.com/qr/library.json" value={url}
            disabled={!remote.ready || remote.saving} onChange={e => { setUrl(e.currentTarget.value); setStatus(""); }} /></label>
        <label>自定义库访问密钥（可选）<input type="password" autoComplete="new-password" spellCheck={false} placeholder={isDefault ? "默认社区云端使用 Discord 登录" : "无鉴权时留空"} value={isDefault ? "" : accessKey}
            disabled={!remote.ready || remote.saving || isDefault} onChange={e => { setAccessKey(e.currentTarget.value); setStatus(""); }} /></label>
        <div className="aqr-remote-actions">
            <Button loading={remote.saving} disabled={!remote.ready} onClick={async () => {
                setError(""); setStatus("");
                try { await saveRemoteConfig({ url, accessKey }); setStatus("连接已保存。打开云端面板即可获取答疑库。"); }
                catch (e) { setError(errorText(e)); }
            }}>保存连接</Button>
            <Button disabled={!remote.ready || remote.saving} onClick={async () => {
                setError(""); setStatus("");
                try { await saveRemoteConfig({ url: DEFAULT_REMOTE_URL, accessKey: "" }); setUrl(DEFAULT_REMOTE_URL); setAccessKey(""); setStatus("已恢复默认社区云端。"); }
                catch (e) { setError(errorText(e)); }
            }}>恢复默认云端</Button>
            <span className="aqr-faint">默认云端只发送插件自己的登录会话，绝不发送 Discord 账号 token。自定义库密钥仅存本机，不写入 QR 备份。</span>
        </div>
        {(error || remote.error) && <Banner tone="danger">{error || remote.error}</Banner>}
        {status && <Banner tone="positive">{status}</Banner>}
    </section>;
}

function KeywordChips({ values, tone }: { values: readonly string[]; tone: "accent" | "neutral"; }) {
    if (!values.length) return <span className="aqr-faint">未设置</span>;
    return <>{values.map(value => <span key={value} className={cx("aqr-chip", tone === "accent" && "aqr-chip--accent")}>{value}</span>)}</>;
}

/** Renders with Discord's own markdown parser, so the preview matches what will be sent. */
function RichText({ text }: { text: string; }) {
    try {
        if (Parser?.parse) return <>{Parser.parse(text)}</>;
    } catch { /* fall through to plain text */ }
    return <>{text}</>;
}

interface SegmentOption<T extends string> { value: T; label: string; count?: number; }

function Segmented<T extends string>({ options, value, onChange }: { options: SegmentOption<T>[]; value: T | null; onChange(value: T): void; }) {
    const index = options.findIndex(o => o.value === value);
    return <div className={cx("aqr-seg", index < 0 && "is-idle")} role="tablist" style={cssVars({ "--n": options.length, "--idx": Math.max(index, 0) })}>
        <span className="aqr-seg-pill" aria-hidden="true" />
        {options.map(option => <button
            type="button"
            role="tab"
            key={option.value}
            aria-selected={option.value === value}
            className={cx("aqr-seg-btn", option.value === value && "is-active")}
            onMouseDown={e => e.preventDefault()}
            onClick={() => onChange(option.value)}
        >
            {option.label}
            {option.count !== undefined && <span className="aqr-seg-count">{option.count}</span>}
        </button>)}
    </div>;
}

/* ───────────────────────────── editor ───────────────────────────── */

export function blankEntry(): QREntry {
    return { id: crypto.randomUUID(), title: "", keywords: [], weakKeywords: [], content: "", images: [], favorite: false, updatedAt: Date.now() };
}

export function openEditor(entry = blankEntry()) {
    openModal(props => <Editor modalProps={props} entry={entry} />);
}

export async function captureMessage(source: Message | ReplyTarget) {
    try {
        const message = snapshotReplyTarget(source);
        await loadLibrary();
        const entry = blankEntry();
        entry.content = message.content ?? "";
        entry.title = entry.content.split("\n")[0].slice(0, 60) || "图片答疑";
        const guildId = ChannelStore.getChannel(message.channel_id)?.guild_id ?? "@me";
        entry.sourceUrl = `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`;
        const attachments = imageAttachments(message);
        if (attachments.length) showQrToast("正在保存图片到本地…");
        for (const attachment of attachments.slice(0, 10)) {
            const image = await imageTools().fetchImage(attachment.url);
            entry.images.push({ ...image, id: crypto.randomUUID(), name: attachment.filename || image.name });
        }
        openEditor(entry);
    } catch (error) {
        showQrToast(`收录失败：${errorText(error)}`, "failure");
    }
}

interface KeywordFieldProps {
    label: string;
    hint: string;
    tone: "accent" | "neutral";
    placeholder: string;
    values: string[];
    pending: string;
    onValues(values: string[]): void;
    onPending(value: string): void;
}

function KeywordField({ label, hint, tone, placeholder, values, pending, onValues, onPending }: KeywordFieldProps) {
    const input = useRef<HTMLInputElement>(null);
    const [armed, setArmed] = useState(false);
    const [flash, setFlash] = useState("");
    const [leaving, exit] = useExit(140);
    const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(flashTimer.current), []);

    function flashChip(value: string) {
        setFlash("");
        requestAnimationFrame(() => setFlash(value));
        clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlash(""), 520);
    }

    /** Commits every complete keyword in `text`; returns whatever is left to keep typing. */
    function commit(text: string, keepTail: boolean) {
        const parts = text.split(/[\n,，;；]/);
        const tail = keepTail ? parts.pop() ?? "" : "";
        const known = new Map(values.map(v => [normalizeText(v), v]));
        const added: string[] = [];
        for (const raw of parts) {
            const value = raw.trim();
            const key = normalizeText(value);
            if (!key) continue;
            const existing = known.get(key);
            if (existing) { flashChip(existing); continue; }
            known.set(key, value);
            added.push(value);
        }
        if (added.length) onValues([...values, ...added]);
        onPending(tail);
    }

    function remove(value: string) {
        exit(value, () => onValues(values.filter(v => v !== value)));
    }

    return <div className="aqr-field">
        <div className="aqr-field-head">
            <span className="aqr-label">{label}</span>
            <span className="aqr-field-hint">{hint}</span>
        </div>
        <div className={cx("aqr-chipfield", `is-${tone}`)} onClick={() => input.current?.focus()}>
            {values.map((value, i) => <span
                key={value}
                className={cx(
                    "aqr-chip", tone === "accent" && "aqr-chip--accent", "aqr-chip--removable",
                    armed && i === values.length - 1 && "is-armed",
                    flash === value && "is-flash",
                    leaving.has(value) && "is-leaving"
                )}
            >
                {value}
                <button type="button" tabIndex={-1} aria-label={`移除 ${value}`} onClick={e => { e.stopPropagation(); remove(value); }}><Icon name="x" size={11} /></button>
            </span>)}
            <input
                ref={input}
                value={pending}
                placeholder={values.length ? "" : placeholder}
                aria-label={label}
                onChange={e => {
                    setArmed(false);
                    const text = e.currentTarget.value;
                    if (/[\n,，;；]/.test(text)) commit(text, true);
                    else onPending(text);
                }}
                onPaste={e => {
                    const text = e.clipboardData.getData("text");
                    if (!/[\n,，;；]/.test(text)) return;
                    e.preventDefault();
                    const { selectionStart: start, selectionEnd: end } = e.currentTarget;
                    commit(pending.slice(0, start ?? pending.length) + text + pending.slice(end ?? pending.length), false);
                }}
                onKeyDown={e => {
                    if (isComposing(e)) return;
                    if (e.key === "Enter") {
                        e.preventDefault();
                        commit(pending, false);
                    } else if (e.key === "Backspace" && !pending && values.length) {
                        e.preventDefault();
                        if (armed) { setArmed(false); remove(values[values.length - 1]); } else setArmed(true);
                    } else if (armed) setArmed(false);
                }}
                onBlur={() => { setArmed(false); if (pending.trim()) commit(pending, false); }}
            />
        </div>
    </div>;
}

function ImageTray({ images, busy, onAdd, onRemove }: { images: QRImage[]; busy: boolean; onAdd(files: File[]): void; onRemove(id: string): void; }) {
    const [over, setOver] = useState(false);
    const depth = useRef(0);
    const input = useRef<HTMLInputElement>(null);
    const [leaving, exit] = useExit(180);
    const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
    const full = images.length >= QR_LIMITS.imagesPerEntry;

    return <div
        className={cx("aqr-tray", over && "is-over")}
        onDragEnter={e => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); depth.current++; setOver(true); }}
        onDragOver={e => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "copy"; }}
        onDragLeave={e => { if (!hasFiles(e)) return; e.stopPropagation(); if (--depth.current <= 0) { depth.current = 0; setOver(false); } }}
        onDrop={e => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            depth.current = 0;
            setOver(false);
            const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
            if (files.length && !busy) onAdd(files);
        }}
    >
        {images.map((image, i) => <figure key={image.id} className={cx("aqr-thumb", leaving.has(image.id) && "is-leaving")} style={cssVars({ "--i": Math.min(i, 10) })} title={image.name}>
            <img src={image.dataUrl} alt={image.name} draggable={false} />
            <figcaption>{image.name}</figcaption>
            <button type="button" className="aqr-thumb-remove" disabled={busy} aria-label={`移除图片 ${image.name}`} onClick={() => exit(image.id, () => onRemove(image.id))}>
                <Icon name="x" size={13} />
            </button>
        </figure>)}
        {!full && <button type="button" className={cx("aqr-tray-add", !images.length && "is-wide")} disabled={busy} onClick={() => input.current?.click()}>
            {busy ? <span className="aqr-spinner" aria-hidden="true" /> : <Icon name="image" size={22} />}
            <span>{busy ? "正在读取…" : "添加图片"}</span>
            <small>{images.length ? "或拖入 / 粘贴" : "点击选择，也可以拖入或直接粘贴截图"}</small>
        </button>}
        <div className="aqr-tray-drop" aria-hidden="true"><Icon name="import" size={22} />松开以添加图片</div>
        <input ref={input} className="aqr-hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={e => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = "";
            if (files.length) onAdd(files);
        }} />
    </div>;
}

function Editor({ modalProps, entry }: { modalProps: RenderModalProps; entry: QREntry; }) {
    const [draft, setDraft] = useState<QREntry>({ ...entry, images: [...entry.images] });
    const [keywords, setKeywords] = useState<string[]>([...entry.keywords]);
    const [weakKeywords, setWeakKeywords] = useState<string[]>([...entry.weakKeywords]);
    const [keywordText, setKeywordText] = useState("");
    const [weakText, setWeakText] = useState("");
    const [busy, setBusy] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [deleteArmed, setDeleteArmed] = useState(false);
    const saved = useMemo(() => getEntries().some(e => e.id === entry.id), []);
    const { length } = draft.content;
    const canSave = !!draft.title.trim() && !!(draft.content.trim() || draft.images.length) && !busy;

    useEffect(() => {
        if (!deleteArmed) return;
        const timer = setTimeout(() => setDeleteArmed(false), 4000);
        return () => clearTimeout(timer);
    }, [deleteArmed]);

    async function addImages(files: File[]) {
        setBusy(true);
        setError("");
        try {
            if (draft.images.length + files.length > QR_LIMITS.imagesPerEntry) throw new Error("一条 QR 最多保存 10 张图片。");
            const images = await Promise.all(files.map(fileToImage));
            setDraft(d => ({ ...d, images: [...d.images, ...images] }));
        } catch (e) { setError(errorText(e)); }
        finally { setBusy(false); }
    }

    async function save() {
        if (saving || !canSave) return;
        setSaving(true);
        setError("");
        try {
            await saveEntry({
                ...draft,
                title: draft.title.trim(),
                keywords: mergeKeywords(keywords, keywordText),
                weakKeywords: mergeKeywords(weakKeywords, weakText),
                updatedAt: Date.now()
            });
            modalProps.onClose();
            showQrToast("已保存答疑 QR", "success");
        } catch (e) { setError(errorText(e)); }
        finally { setSaving(false); }
    }

    async function remove() {
        if (!deleteArmed) { setDeleteArmed(true); return; }
        setSaving(true);
        try { await deleteEntry(entry.id); modalProps.onClose(); showQrToast(`已删除「${entry.title}」`, "success"); }
        catch (e) { setError(errorText(e)); }
        finally { setSaving(false); }
    }

    return <Modal
        {...modalProps}
        size="lg"
        title={saved ? "编辑答疑 QR" : "收录答疑 QR"}
        subtitle="保存一段图文答复，并设置遇到哪些关键词时推荐它。"
        actions={[
            { text: "取消", variant: "secondary", onClick: modalProps.onClose },
            { text: "保存 QR", variant: "primary", onClick: save, loading: saving, disabled: !canSave }
        ]}
    >
        <div className="aqr-root aqr-editor" onPaste={e => {
            const files = Array.from(e.clipboardData.files).filter(f => f.type.startsWith("image/"));
            if (files.length && !busy) { e.preventDefault(); void addImages(files); }
        }}>
            {error && <Banner tone="danger" onDismiss={() => setError("")}>{error}</Banner>}

            <div className="aqr-field">
                <div className="aqr-field-head"><span className="aqr-label">名称</span></div>
                <input
                    className="aqr-input aqr-title-input"
                    autoFocus
                    maxLength={QR_LIMITS.title}
                    value={draft.title}
                    onChange={e => setDraft({ ...draft, title: e.currentTarget.value })}
                    placeholder="例如：网络与流式通用排查"
                />
            </div>

            <div className="aqr-grid-2">
                <KeywordField
                    label="触发词" hint="命中任意一个即推荐" tone="accent" placeholder="输入后回车，如 524"
                    values={keywords} pending={keywordText} onValues={setKeywords} onPending={setKeywordText}
                />
                <KeywordField
                    label="辅助词" hint="宽泛线索，只提示可能相关" tone="neutral" placeholder="如 cloudflare、超时"
                    values={weakKeywords} pending={weakText} onValues={setWeakKeywords} onPending={setWeakText}
                />
            </div>

            <div className="aqr-field">
                <div className="aqr-field-head">
                    <span className="aqr-label">回复文字</span>
                    <span className={cx("aqr-counter", length > 2000 && "is-warn", length > 3800 && "is-danger")} title="超过 2000 字需要 Nitro 才能发送">
                        {length} / {QR_LIMITS.content}
                    </span>
                </div>
                <textarea
                    className="aqr-input aqr-textarea"
                    rows={5}
                    maxLength={QR_LIMITS.content}
                    value={draft.content}
                    onChange={e => setDraft({ ...draft, content: e.currentTarget.value })}
                    placeholder="将要发送的答复，支持链接和 Discord Markdown。"
                />
            </div>

            <div className="aqr-field">
                <div className="aqr-field-head">
                    <span className="aqr-label">回复图片</span>
                    <span className="aqr-counter">{draft.images.length} / {QR_LIMITS.imagesPerEntry}</span>
                </div>
                <ImageTray
                    images={draft.images}
                    busy={busy}
                    onAdd={files => void addImages(files)}
                    onRemove={id => setDraft(d => ({ ...d, images: d.images.filter(i => i.id !== id) }))}
                />
            </div>

            <div className="aqr-editor-foot">
                <Switch checked={draft.favorite} onChange={favorite => setDraft({ ...draft, favorite })} icon="star" label="收藏到右键菜单" hint="右键任意消息时直接显示" />
                <div className="aqr-editor-foot-end">
                    {draft.sourceUrl && <button type="button" className="aqr-link" onClick={() => openSourceMessage(draft.sourceUrl!)}><Icon name="link" size={14} />收录来源</button>}
                    {saved && <Button variant="danger" size="sm" icon="trash" className={cx("aqr-confirm", deleteArmed && "is-armed")} disabled={saving} onClick={remove}>
                        {deleteArmed ? "再点一次删除" : "删除"}
                    </Button>}
                </div>
            </div>
        </div>
    </Modal>;
}

/* ──────────────────────────── library ──────────────────────────── */

export function openLibrary(source?: Message | ReplyTarget, startOcr = false, initialQuery = "") {
    const message = source && snapshotReplyTarget(source);
    openModal(props => <Library modalProps={props} message={message} startOcr={startOcr} initialQuery={initialQuery} />);
}

function downloadBackup() {
    const url = URL.createObjectURL(new Blob([exportLibrary()], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `answer-qr-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Tab = "match" | "fav" | "all";
interface Snack { id: number; text: string; tone: "info" | "positive"; undo?: QREntry; }

function Library({ modalProps, message, startOcr, initialQuery = "" }: { modalProps: RenderModalProps; message?: ReplyTarget; startOcr: boolean; initialQuery?: string; }) {
    const { entries: localEntries, error: loadError } = useLibrary();
    const remote = useRemoteLibrary();
    const [source, setSource] = useState<"local" | "remote">(message && !initialQuery ? "remote" : "local");
    const [showConnection, setShowConnection] = useState(false);
    const [copying, setCopying] = useState("");
    const copyRunning = useRef(false);
    const readOnly = source === "remote";
    const entries = readOnly ? remote.entries : localEntries;
    const [query, setQuery] = useState(initialQuery);
    const [tab, setTab] = useState<Tab | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [snack, setSnack] = useState<Snack | null>(null);
    const [ocrText, setOcrText] = useState("");
    const [ocrBusy, setOcrBusy] = useState(false);
    const [ocrOpen, setOcrOpen] = useState(false);
    const [imageIndex, setImageIndex] = useState(0);
    const [sending, setSending] = useState("");
    const [mention, setMention] = useState(settings.store.mentionReply);
    const [leaving, exit] = useExit(220);
    const searchRef = useRef<HTMLInputElement>(null);
    const importInput = useRef<HTMLInputElement>(null);
    const ocrStarted = useRef(false);
    const ocrRunning = useRef(false);
    const mounted = useRef(true);

    useEffect(() => {
        if (readOnly && remote.ready && !remote.saving) void ensureRemoteLibrary().catch(() => {});
        // Cache/error updates must not retrigger this effect. Reopening or
        // changing source/config checks TTL/backoff; there is no polling.
    }, [source, remote.ready, remote.saving, remote.config]);

    const attachments = useMemo(() => message ? imageAttachments(message) : [], [message]);
    const matches = useMemo(() => message
        ? matchEntries(entries, [{ text: message.content ?? "", label: "消息正文" }, { text: ocrText, label: "图片识别" }])
        : [], [entries, message, ocrText]);
    const matchMap = useMemo(() => new Map(matches.map(m => [m.entry.id, m])), [matches]);
    const favorites = useMemo(() => entries.filter(e => e.favorite).sort((a, b) => b.updatedAt - a.updatedAt), [entries]);
    const everything = useMemo(() => [
        ...matches.map(m => m.entry),
        ...entries.filter(e => !matchMap.has(e.id)).sort(byFavoriteThenRecent)
    ], [entries, matches, matchMap]);

    const searching = !!query.trim();
    const activeTab: Tab = tab ?? (matches.length ? "match" : "all");
    const visible = searching ? searchEntries(entries, query)
        : activeTab === "match" ? matches.map(m => m.entry)
            : activeTab === "fav" ? favorites
                : everything;
    const selected = visible.find(e => e.id === selectedId) ?? visible[0];
    const listKey = `${source}-${searching ? "search" : activeTab}`;

    const tabs: SegmentOption<Tab>[] = [
        ...(message ? [{ value: "match" as const, label: "推荐", count: matches.length }] : []),
        { value: "fav", label: readOnly ? "库中标星" : "收藏", count: favorites.length },
        { value: "all", label: "全部", count: entries.length }
    ];

    useEffect(() => {
        mounted.current = true;
        if (startOcr && !ocrStarted.current && attachments.length) { ocrStarted.current = true; void recognize(); }
        return () => { mounted.current = false; };
    }, []);

    useEffect(() => {
        if (!snack) return;
        const timer = setTimeout(() => setSnack(s => s?.id === snack.id ? null : s), snack.undo ? 6500 : 3500);
        return () => clearTimeout(timer);
    }, [snack]);

    useLayoutEffect(() => {
        if (selected) document.getElementById(`aqr-opt-${selected.id}`)?.scrollIntoView({ block: "nearest" });
    }, [selected?.id]);

    const toast = (text: string, tone: Snack["tone"] = "info", undo?: QREntry) => setSnack({ id: Date.now() + Math.random(), text, tone, undo });

    async function recognize() {
        if (!message || ocrRunning.current) return;
        ocrRunning.current = true;
        setOcrBusy(true);
        setError("");
        setOcrText("");
        try {
            const text = await recognizeAttachment(message, imageIndex);
            if (!mounted.current) return;
            setOcrText(text);
            setTab(null);
            toast(text.trim() ? "图片识别完成，推荐已更新" : "没有识别出文字，可以换一张图或手动搜索", text.trim() ? "positive" : "info");
        } catch (e) { if (mounted.current) setError(errorText(e)); }
        finally { ocrRunning.current = false; if (mounted.current) setOcrBusy(false); }
    }

    async function send(entry: QREntry) {
        if (!message || sending) return;
        setSending(entry.id);
        setError("");
        try { await sendReply(entry, message, mention); modalProps.onClose(); showQrToast("答疑 QR 已发送", "success"); }
        catch (e) { setError(errorText(e)); }
        finally { if (mounted.current) setSending(""); }
    }

    function primary(entry: QREntry) {
        if (message) void send(entry);
        else if (readOnly) void copyToLocal(entry);
        else openEditor(entry);
    }

    async function copyToLocal(entry: QREntry) {
        if (copyRunning.current) return;
        copyRunning.current = true;
        setCopying(entry.id);
        setError("");
        try { await saveRemoteEntryLocally(entry); if (mounted.current) toast(`已将「${entry.title}」保存到本地`, "positive"); }
        catch (e) { if (mounted.current) setError(errorText(e)); }
        finally { copyRunning.current = false; if (mounted.current) setCopying(""); }
    }

    async function copyVisibleToLocal() {
        if (!readOnly || !visible.length || copyRunning.current || remote.loading || remote.saving) return;
        copyRunning.current = true;
        setCopying("__batch");
        setError("");
        try {
            const { imported, skipped } = await saveRemoteEntriesLocally(visible);
            if (mounted.current) toast(`已导入 ${imported} 条 QR${skipped ? `，跳过 ${skipped} 条相同内容` : ""}`, "positive");
        } catch (e) { if (mounted.current) setError(errorText(e)); }
        finally { copyRunning.current = false; if (mounted.current) setCopying(""); }
    }

    function remove(entry: QREntry) {
        if (readOnly || sending || leaving.has(entry.id)) return;
        if (selected?.id === entry.id) {
            const index = visible.findIndex(e => e.id === entry.id);
            setSelectedId((visible[index + 1] ?? visible[index - 1])?.id ?? null);
        }
        exit(entry.id, async () => {
            try {
                await deleteEntry(entry.id);
                toast(`已删除「${entry.title}」`, "info", entry);
            } catch (e) { setError(errorText(e)); }
        });
    }

    function restore(entry: QREntry) {
        setSnack(null);
        saveEntry(entry)
            .then(() => { setSelectedId(entry.id); toast(`已恢复「${entry.title}」`, "positive"); })
            .catch(e => setError(errorText(e)));
    }

    function toggleFavorite(entry: QREntry) {
        if (readOnly) return;
        saveEntry({ ...entry, favorite: !entry.favorite, updatedAt: Date.now() }).catch(e => setError(errorText(e)));
    }

    function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
        if (isComposing(e)) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!visible.length) return;
            const index = visible.findIndex(v => v.id === selected?.id);
            const next = e.key === "ArrowDown" ? Math.min(index + 1, visible.length - 1) : Math.max(index - 1, 0);
            setSelectedId(visible[next].id);
        } else if (e.key === "Enter" && selected && !leaving.has(selected.id)) {
            e.preventDefault();
            primary(selected);
        }
    }

    async function onImport(file: File) {
        if (file.size > 100 * 1024 * 1024) { setError("备份文件不能超过 100 MB。"); return; }
        try {
            const json = await file.text();
            openModal(props => <ConfirmModal {...props} title="合并导入 QR 库" confirmText="合并导入" cancelText="取消" variant="primary" onConfirm={async setImportError => {
                try { const count = await importLibrary(json); toast(`已导入 ${count} 条 QR`, "positive"); }
                catch (e) { setImportError(errorText(e)); throw e; }
            }}><p className="aqr-root aqr-confirm-text">导入会保留其他 QR；遇到相同 ID 时，用备份中的内容更新。建议先导出当前库。</p></ConfirmModal>);
        } catch (e) { setError(errorText(e)); }
    }

    const emptyText = searching ? `没有找到与「${query.trim()}」相关的 QR`
        : activeTab === "match" ? "这条消息没有命中任何关键词"
            : activeTab === "fav" ? "还没有收藏的 QR" : "没有 QR";

    const snackNode = snack && <div className={cx("aqr-snack", `is-${snack.tone}`)} key={snack.id} role="status">
        <Icon name={snack.tone === "positive" ? "check" : snack.undo ? "trash" : "spark"} size={15} />
        <span>{snack.text}</span>
        {snack.undo && <button type="button" className="aqr-snack-action" onClick={() => restore(snack.undo!)}>撤销</button>}
    </div>;

    return <Modal
        {...modalProps}
        size="xl"
        title={message ? "选择答疑 QR" : "答疑 QR 库"}
        subtitle={message ? "按关键词推荐，预览后引用原消息发送。" : "本地库可管理；云端库只读，可预览发送或保存到本地。"}
        actions={[{ text: "关闭", variant: "secondary", onClick: modalProps.onClose }]}
    >
        <div className={cx("aqr-root aqr-library", message && "has-target")}>
            {message && <section className="aqr-target">
                <div className="aqr-target-row">
                    <Avatar message={message} size={36} />
                    <div className="aqr-target-main">
                        <div className="aqr-target-head"><span className="aqr-eyebrow">回复给</span><strong>{authorName(message)}</strong></div>
                        <p className="aqr-target-text">{message.content?.trim() || (attachments.length ? `[${attachments.length} 张图片]` : "（无文字内容）")}</p>
                    </div>
                    <Switch checked={mention} onChange={setMention} icon="bell" label="提醒对方" />
                </div>
                {!!attachments.length && <div className="aqr-ocr">
                    <div className="aqr-ocr-thumbs" role="radiogroup" aria-label="选择要识别的图片">
                        {attachments.map((attachment, i) => <button
                            type="button"
                            role="radio"
                            aria-checked={i === imageIndex}
                            key={attachment.id}
                            title={attachment.filename}
                            disabled={ocrBusy}
                            className={cx("aqr-ocr-thumb", i === imageIndex && "is-active", ocrBusy && i === imageIndex && "is-scanning")}
                            onClick={() => { if (i !== imageIndex) { setImageIndex(i); setOcrText(""); } }}
                        >
                            <img src={thumbnailOf(attachment)} alt="" draggable={false} />
                        </button>)}
                    </div>
                    <Button size="sm" icon="scan" loading={ocrBusy} onClick={recognize}>{ocrBusy ? "识别中…" : ocrText ? "重新识别" : "识别图片文字"}</Button>
                    {!!ocrText && <button type="button" className={cx("aqr-disclosure", ocrOpen && "is-open")} aria-expanded={ocrOpen} onClick={() => setOcrOpen(o => !o)}>
                        识别结果 <Icon name="chevron" size={14} />
                    </button>}
                    <span className="aqr-ocr-note">在本机识别，不会上传</span>
                </div>}
                {!!ocrText && <Collapse open={ocrOpen}><pre className="aqr-ocr-text">{ocrText}</pre></Collapse>}
            </section>}

            <div className="aqr-source-toolbar">
                <Segmented options={[{ value: "local" as const, label: "本地", count: localEntries.length }, { value: "remote" as const, label: "云端", count: remote.entries.length }]}
                    value={source} onChange={value => { setSource(value); setSelectedId(null); setTab(null); setError(""); setSnack(null); }} />
                <Button variant="ghost" onClick={() => openContributions()}>Discord 登录 / 投稿</Button>
                {readOnly && <>
                    <Button loading={remote.loading} disabled={!remote.ready || remote.saving || !remote.config.url} onClick={() => {
                        setError("");
                        refreshRemoteLibrary().catch(() => {});
                    }}>刷新答疑库</Button>
                    <Button icon="import" loading={copying === "__batch"}
                        disabled={!visible.length || remote.loading || remote.saving || !!sending || !!copying}
                        title="将当前列表复制到本地；相同内容会跳过，不覆盖已有 QR。"
                        onClick={() => void copyVisibleToLocal()}>
                        {searching || activeTab !== "all" ? "导入当前结果" : "全部导入本地"}（{visible.length}）
                    </Button>
                    <Button variant="ghost" onClick={() => setShowConnection(value => !value)}>{showConnection ? "收起高级设置" : "高级设置"}</Button>
                    <span className="aqr-faint">{remote.loading ? "正在获取云端答疑库…" : remote.fetchedAt === null ? "打开时自动获取，可手动重试" : `${remote.stale ? "缓存可能已过期 · " : ""}获取于 ${relativeTime(remote.fetchedAt)}`}</span>
                </>}
            </div>
            {readOnly && showConnection && <RemoteConnection />}
            {readOnly && remote.error && !showConnection && <Banner tone="danger">{remote.error}{remote.stale ? " 当前仍显示同一连接上次成功获取的缓存，可预览后决定是否使用。" : ""}</Banner>}

            <div className="aqr-toolbar">
                <label className="aqr-search">
                    <Icon name="search" size={16} className="aqr-search-icon" />
                    <input
                        ref={searchRef}
                        autoFocus
                        role="combobox"
                        aria-expanded="true"
                        aria-controls="aqr-listbox"
                        aria-activedescendant={selected ? `aqr-opt-${selected.id}` : undefined}
                        aria-label="搜索答疑 QR"
                        value={query}
                        onChange={e => setQuery(e.currentTarget.value)}
                        onKeyDown={onSearchKey}
                        placeholder="搜索名称、关键词或回复内容"
                    />
                    {searching && <button type="button" className="aqr-search-clear" aria-label="清空搜索" onClick={() => { setQuery(""); searchRef.current?.focus(); }}><Icon name="x" size={13} /></button>}
                </label>
                <Segmented options={tabs} value={searching ? null : activeTab} onChange={value => { setQuery(""); setTab(value); }} />
                {!readOnly && <div className="aqr-toolbar-end">
                    <Button icon="plus" onClick={() => openEditor()}>新建</Button>
                    <Button variant="ghost" icon="import" title="导入备份" aria-label="导入备份" onClick={() => importInput.current?.click()} />
                    <Button variant="ghost" icon="export" title="导出备份" aria-label="导出备份" onClick={async () => {
                        try { await loadLibrary(); downloadBackup(); toast("备份已导出", "positive"); } catch (e) { setError(errorText(e)); }
                    }} />
                </div>}
                <input ref={importInput} className="aqr-hidden" type="file" accept="application/json,.json" onChange={e => {
                    const file = e.currentTarget.files?.[0];
                    e.currentTarget.value = "";
                    if (file) void onImport(file);
                }} />
            </div>

            {(error || (!readOnly && loadError)) && <Banner tone="danger" onDismiss={error ? () => setError("") : undefined}>{error || loadError}</Banner>}

            {!entries.length ? <div className="aqr-split is-empty">
                <div className="aqr-detail is-full">
                    {readOnly ? <div className="aqr-welcome"><Icon name="layers" size={26} /><h3>{remote.loading ? "正在获取云端 QR…" : remote.error ? "暂时无法获取云端 QR" : "暂无云端 QR"}</h3>
                        <p>社区云端库需先通过「Discord 登录 / 投稿」登录答疑成员账号。云端内容更新后，重新打开面板或点击刷新即可获取；也可以切换到本地使用自己的 QR。</p>
                    </div> : <Welcome onCreate={() => openEditor()} />}
                    {snackNode}
                </div>
            </div> : <div className="aqr-split">
                <div className="aqr-list-wrap">
                    <div className="aqr-list" role="listbox" id="aqr-listbox" aria-label="答疑 QR" key={listKey}>
                        {visible.map((entry, i) => <Row
                            key={entry.id}
                            entry={entry}
                            index={i}
                            match={matchMap.get(entry.id)}
                            selected={entry.id === selected?.id}
                            leaving={leaving.has(entry.id)}
                            disabled={!!sending || !!copying}
                            onSelect={() => { setSelectedId(entry.id); searchRef.current?.focus({ preventScroll: true }); }}
                            onDelete={readOnly ? undefined : () => remove(entry)}
                        />)}
                        {!visible.length && <div className="aqr-list-empty">
                            <Icon name={searching ? "search" : "inbox"} size={22} />
                            <span>{emptyText}</span>
                            {activeTab === "match" && !searching && <small>{attachments.length ? "可以识别图片文字，或者直接搜索" : "可以直接搜索，或者查看全部"}</small>}
                        </div>}
                        {activeTab === "match" && !searching && entries.length > visible.length && <button
                            type="button"
                            className="aqr-list-more"
                            style={cssVars({ "--i": Math.min(visible.length, 14) })}
                            onMouseDown={e => e.preventDefault()}
                            onClick={() => setTab("all")}
                        >
                            查看全部 {entries.length} 条<Icon name="chevron" size={14} />
                        </button>}
                    </div>
                    {snackNode}
                </div>

                <div className="aqr-detail">
                    {selected ? <Detail
                        key={`${source}-${selected.id}`}
                        entry={selected}
                        match={matchMap.get(selected.id)}
                        message={message}
                        mention={mention}
                        sending={sending === selected.id}
                        busy={!!sending || !!copying}
                        readOnly={readOnly}
                        copying={copying === selected.id}
                        onSaveLocal={() => void copyToLocal(selected)}
                        onPrimary={() => primary(selected)}
                        onEdit={() => openEditor(selected)}
                        onFavorite={() => toggleFavorite(selected)}
                        onDelete={() => remove(selected)}
                    /> : <div className="aqr-detail-empty"><Icon name="layers" size={26} /><span>{visible.length ? "选择一条 QR 预览" : "没有可预览的 QR"}</span></div>}
                </div>
            </div>}
        </div>
    </Modal>;
}

function Avatar({ message, size }: { message: ReplyTarget; size: number; }) {
    const [failed, setFailed] = useState(false);
    const src = message.avatarUrl;
    const style = cssVars({ "--size": `${size}px` });
    if (!src || failed) return <span className="aqr-avatar is-fallback" style={style} aria-hidden="true">{authorName(message).slice(0, 1).toUpperCase()}</span>;
    return <img className="aqr-avatar" style={style} src={src} alt="" onError={() => setFailed(true)} />;
}

interface RowProps {
    entry: QREntry;
    index: number;
    match?: QRMatch;
    selected: boolean;
    leaving: boolean;
    disabled: boolean;
    onSelect(): void;
    onDelete?(): void;
}

function Row({ entry, index, match, selected, leaving, disabled, onSelect, onDelete }: RowProps) {
    const strong = !!match && match.score >= 100;
    const preview = plainPreview(entry);
    return <div
        role="option"
        id={`aqr-opt-${entry.id}`}
        aria-selected={selected}
        className={cx("aqr-row", selected && "is-selected", leaving && "is-leaving", match && (strong ? "is-match" : "is-related"))}
        style={cssVars({ "--i": Math.min(index, 14) })}
        onMouseDown={e => e.preventDefault()}
        onClick={onSelect}
    >
        <div className="aqr-row-clip">
            <div className="aqr-row-body">
                <div className="aqr-row-main">
                    <div className="aqr-row-title">
                        {entry.favorite && <Icon name="star" size={12} filled className="aqr-row-star" />}
                        <span>{entry.title}</span>
                    </div>
                    <div className="aqr-row-sub">{preview}</div>
                </div>
                <div className="aqr-row-meta">
                    {match && <span className={cx("aqr-badge", strong ? "is-strong" : "is-weak")}>{strong ? "命中" : "相关"}</span>}
                    {!!entry.images.length && <span className="aqr-row-count" title={`${entry.images.length} 张图片`}><Icon name="image" size={12} />{entry.images.length}</span>}
                </div>
                {onDelete && <button
                    type="button"
                    tabIndex={-1}
                    className="aqr-row-delete"
                    disabled={disabled}
                    aria-label={`删除 QR：${entry.title}`}
                    title="删除这条 QR（可撤销）"
                    onClick={e => { e.stopPropagation(); onDelete(); }}
                >
                    <Icon name="x" size={14} />
                </button>}
            </div>
        </div>
    </div>;
}

interface DetailProps {
    entry: QREntry;
    match?: QRMatch;
    message?: ReplyTarget;
    mention: boolean;
    sending: boolean;
    busy: boolean;
    readOnly: boolean;
    copying: boolean;
    onSaveLocal(): void;
    onPrimary(): void;
    onEdit(): void;
    onFavorite(): void;
    onDelete(): void;
}

function Detail({ entry, match, message, mention, sending, busy, readOnly, copying, onSaveLocal, onPrimary, onEdit, onFavorite, onDelete }: DetailProps) {
    const strong = !!match && match.score >= 100;
    const count = entry.images.length;
    return <article className="aqr-detail-card">
        <header className="aqr-detail-head">
            <div className="aqr-detail-title">
                <h3>{entry.title}</h3>
                <span className="aqr-detail-meta">更新于 {relativeTime(entry.updatedAt)}{count ? ` · ${count} 张图片` : ""}</span>
            </div>
            <div className="aqr-detail-tools">
                {readOnly ? <Button icon="import" size="sm" loading={copying} disabled={busy && !copying} onClick={onSaveLocal}>保存到本地</Button> : <><Button
                    variant="ghost" size="sm"
                    className={cx("aqr-fav", entry.favorite && "is-on")}
                    aria-pressed={entry.favorite}
                    title={entry.favorite ? "取消收藏" : "收藏到右键菜单"}
                    aria-label={entry.favorite ? "取消收藏" : "收藏"}
                    onClick={onFavorite}
                ><span key={String(entry.favorite)} className="aqr-fav-icon"><Icon name="star" filled={entry.favorite} /></span></Button>
                <Button variant="ghost" size="sm" icon="edit" title="编辑" aria-label="编辑" onClick={onEdit} />
                <Button variant="ghost" size="sm" icon="trash" title="删除（可撤销）" aria-label="删除" className="aqr-btn--danger-hover" disabled={busy} onClick={onDelete} />
                <Button size="sm" disabled={busy} onClick={() => openContributions(entry)}>提交到云端</Button>
                </>}
            </div>
        </header>

        <div className="aqr-detail-body">
            {match && <div className={cx("aqr-why", strong ? "is-strong" : "is-weak")}>
                <span className="aqr-why-label"><Icon name="spark" size={14} />{strong ? "关键词命中" : "可能相关"}</span>
                {match.reasons.map(reason => <span key={reason} className="aqr-chip aqr-chip--plain">{reason}</span>)}
            </div>}

            <div className="aqr-eyebrow aqr-section-label">{message ? "发送预览" : "回复内容"}</div>
            <div className="aqr-bubble">
                {message && <div className="aqr-bubble-reply">
                    <Avatar message={message} size={16} />
                    <span className={cx("aqr-bubble-reply-name", mention && "is-mention")}>{mention ? "@" : ""}{authorName(message)}</span>
                    <span className="aqr-bubble-reply-text">{message.content?.trim() || "点击查看附件"}</span>
                </div>}
                {entry.content.trim()
                    ? <div className="aqr-bubble-text"><RichText text={entry.content} /></div>
                    : <div className="aqr-bubble-text is-empty">（仅发送图片）</div>}
                {!!count && <div className={cx("aqr-bubble-images", `n-${Math.min(count, 3)}`)}>
                    {entry.images.map((image, i) => <img key={image.id} src={image.dataUrl} alt={image.name} title={image.name} style={cssVars({ "--i": i })} draggable={false} />)}
                </div>}
            </div>

            <dl className="aqr-keys">
                <div><dt>触发词</dt><dd><KeywordChips values={entry.keywords} tone="accent" /></dd></div>
                <div><dt>辅助词</dt><dd><KeywordChips values={entry.weakKeywords} tone="neutral" /></dd></div>
                {entry.sourceUrl && <div><dt>来源</dt><dd><button type="button" className="aqr-link" onClick={() => openSourceMessage(entry.sourceUrl!)}><Icon name="link" size={13} />查看收录的原消息</button></dd></div>}
            </dl>
        </div>

        <footer className="aqr-detail-foot">
            <span className="aqr-kbd-hint">
                <kbd>↑</kbd><kbd>↓</kbd> 切换
                <kbd className="aqr-kbd-wide">Enter</kbd> {message ? "发送" : readOnly ? "保存到本地" : "编辑"}
            </span>
            {message
                ? <Button variant="primary" icon="reply" loading={sending} disabled={busy && !sending} onClick={onPrimary}>{sending ? "正在发送…" : "引用并发送"}</Button>
                : readOnly ? <Button variant="primary" icon="import" loading={copying} disabled={busy && !copying} onClick={onSaveLocal}>保存到本地</Button>
                    : <Button variant="primary" icon="edit" onClick={onEdit}>编辑这条 QR</Button>}
        </footer>
    </article>;
}

function Welcome({ onCreate }: { onCreate(): void; }) {
    return <div className="aqr-welcome">
        <div className="aqr-welcome-mark"><Icon name="bolt" size={26} /></div>
        <h3>还没有答疑 QR</h3>
        <p>右键一条已有的答复，选择「保存为答疑 QR」，<br />或者从这里新建一条。</p>
        <Button variant="primary" icon="plus" onClick={onCreate}>新建 QR</Button>
    </div>;
}

/* ──────────────────────────── settings ──────────────────────────── */

export function SettingsPanel() {
    const [status, setStatus] = useState<{ tone: "info" | "positive" | "danger"; text: string; } | null>(null);
    const [checking, setChecking] = useState(false);
    return <div className="aqr-root aqr-settings">
        <div className="aqr-settings-card">
            <div className="aqr-welcome-mark is-small"><Icon name="bolt" size={20} /></div>
            <div className="aqr-settings-text">
                <strong>答疑 QR</strong>
                <span>右键问题选择「答疑 QR」发送；右键已有答复选择「保存为答疑 QR」收录。</span>
            </div>
        </div>
        <div className="aqr-settings-actions">
            <Button variant="primary" icon="layers" onClick={() => openLibrary()}>打开 QR 管理</Button>
            <Button icon="scan" loading={checking} onClick={async () => {
                setChecking(true);
                setStatus(null);
                try {
                    const info = await imageTools().getOcrInfo();
                    setStatus(info.available
                        ? { tone: "positive", text: `本地 OCR 可用：${info.languages.join("、")}` }
                        : { tone: "danger", text: IS_WEB
                            ? "当前浏览器无法运行本地 OCR，请使用新版 Chrome 或 Edge。"
                            : "未找到 Windows OCR 语言包，请在 Windows 语言设置中安装对应语言的光学字符识别组件。" });
                } catch (e) { setStatus({ tone: "danger", text: errorText(e) }); }
                finally { setChecking(false); }
            }}>检查本地 OCR</Button>
        </div>
        {status && <Banner tone={status.tone}>{status.text}</Banner>}
        <RemoteConnection />
    </div>;
}
