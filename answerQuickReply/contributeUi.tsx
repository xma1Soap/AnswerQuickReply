/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, useEffect, useRef, UserStore, useState } from "@webpack/common";

import { cancelAutomaticLogin, exchangeLoginCode, getContributionState, listSubmissions, loadContributionPanel, logoutContributions, prepareAutomaticLogin, readSubmission, reviewSubmission, snapshotContribution, Submission, SubmissionDetail, submitContribution, subscribeContributions, waitForAutomaticLogin } from "./contribute";
import { QREntry } from "./model";

const statusName = { pending: "待审核", published: "已发布", rejected: "已驳回" };

export function openContributions(entry?: QREntry): void {
    // Freeze the exact text and images before opening or waiting for authentication.
    const draft = entry && snapshotContribution(entry);
    openModal(props => <ContributionPanel modalProps={props} draft={draft} />);
}

function ContributionPreview({ entry }: { entry: QREntry; }) {
    return <article className="aqr-contribution-preview">
        <h3>{entry.title}</h3>
        <p className="aqr-contribution-content">{entry.content || "（仅图片）"}</p>
        <div className="aqr-contribution-images">{entry.images.map(image => <img key={image.id} src={image.dataUrl} alt={image.name} />)}</div>
        <p>触发词：{entry.keywords.join("、") || "无"}</p><p>辅助词：{entry.weakKeywords.join("、") || "无"}</p>
    </article>;
}

function ContributionPanel({ modalProps, draft }: { modalProps: RenderModalProps; draft?: QREntry; }) {
    const [service, setService] = useState(getContributionState);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [code, setCode] = useState("");
    const [review, setReview] = useState(false);
    const [items, setItems] = useState<Submission[]>([]);
    const [detail, setDetail] = useState<SubmissionDetail | null>(null);
    const [reason, setReason] = useState("");
    const [submitted, setSubmitted] = useState(false);
    const running = useRef(false);
    const mounted = useRef(true);

    async function run(action: () => Promise<void>) {
        if (running.current) return;
        running.current = true; setBusy(true); setError("");
        try { await action(); }
        catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
        finally { running.current = false; if (mounted.current) setBusy(false); }
    }
    async function refresh(wantsReview = review) {
        await loadContributionPanel();
        const current = getContributionState();
        if (!current.user && current.automaticLogin) await prepareAutomaticLogin(UserStore.getCurrentUser()?.id);
        const allowedReview = wantsReview && current.canReview;
        const next = current.enabled && current.user ? await listSubmissions(allowedReview) : [];
        if (mounted.current) { setReview(allowedReview); setItems(next); setDetail(null); }
    }
    useEffect(() => {
        mounted.current = true;
        const unsubscribe = subscribeContributions(() => { if (mounted.current) setService(getContributionState()); });
        void run(() => refresh(false));
        return () => { mounted.current = false; unsubscribe(); };
    }, []);

    return <Modal {...modalProps} size="xl" title={draft ? "提交到社区云端" : "我的提交 / 审核"}
        subtitle="社区云端库与投稿仅对指定服务器中拥有答疑身份组的成员开放；本地 QR 无需登录。"
        actions={[{ text: "关闭", variant: "secondary", onClick: modalProps.onClose }]}>
        <div className="aqr-root aqr-contributions">
            {error && <p className="aqr-banner is-danger" role="alert">{error}</p>}
            {notice && <p className="aqr-banner is-positive" role="status">{notice}</p>}
            {!service.ready ? <p>{busy ? "正在检查贡献服务…" : "暂时无法读取贡献服务状态。"}</p>
                : !service.enabled ? <p className="aqr-banner is-info">管理员尚未开通 Discord 登录，社区云端库与投稿暂不可用；本地 QR 不受影响。</p>
                    : !service.user ? <section className="aqr-remote-connection">
                        <p>在浏览器授权当前 Discord 账号，完成后插件会自动登录，无需复制登录码。授权只读取用户名和答疑服务器中的身份组。</p>
                        {service.automaticLogin && <>
                            {service.autoLoginUrl ? <a className="aqr-btn aqr-btn--primary" href={service.autoLoginUrl} target="_blank" rel="noopener noreferrer" onClick={e => {
                                if (running.current) { e.preventDefault(); return; }
                                void run(async () => {
                                    await waitForAutomaticLogin(() => UserStore.getCurrentUser()?.id);
                                    if (mounted.current) setNotice("Discord 授权成功，已自动登录。");
                                    await refresh(false);
                                });
                            }}>{service.loginWaiting ? "正在等待浏览器授权…" : "使用 Discord 登录"}</a>
                                : <button type="button" className="aqr-btn" disabled={busy} onClick={() => void run(() => refresh(false))}>准备登录</button>}
                            {service.loginWaiting && <div role="status">
                                <p>请在浏览器完成授权，保留此面板。授权后通常 5 秒内登录。</p>
                                <a className="aqr-link" href={service.autoLoginUrl} target="_blank" rel="noopener noreferrer">重新打开授权页面</a>
                                <button type="button" className="aqr-btn" onClick={cancelAutomaticLogin}>取消登录</button>
                            </div>}
                        </>}
                        <details open={!service.automaticLogin}><summary>使用一次性登录码（兼容旧版）</summary>
                        <p>仅兼容方式需要复制登录码；登录码 5 分钟有效。</p>
                        <a className="aqr-link" href={service.loginUrl} target="_blank" rel="noopener noreferrer">打开手动授权页面</a>
                        <label>一次性登录码<input autoComplete="off" type="password" value={code} maxLength={256} disabled={busy} onChange={e => setCode(e.currentTarget.value)} /></label>
                        <button type="button" className="aqr-btn aqr-btn--primary" disabled={busy || !code.trim()} onClick={() => void run(async () => {
                            await exchangeLoginCode(code); if (mounted.current) setCode(""); await refresh(false);
                        })}>兑换登录码</button>
                        </details>
                        <small>不读取 Discord 客户端 token。贡献会话只保存在本机，不进入 QR 备份。</small>
                    </section> : <>
                        <div className="aqr-remote-actions">
                            <span>已登录：{service.user.username}{service.libraryAccess === "denied" ? " · 没有答疑身份组，云端库不可用" : ""}</span>
                            <button type="button" className="aqr-btn" disabled={busy} onClick={() => void run(async () => {
                                await logoutContributions(); if (mounted.current) { setItems([]); setDetail(null); setCode(""); setNotice("已退出贡献服务。"); }
                            })}>退出登录</button>
                        </div>
                        {draft && !submitted && <section>
                            <p>请核对将提交的文字、图片和关键词。{service.canAutoPublish ? "服务授予当前账号免审权限，提交后可直接发布。" : "提交后由管理员审核，通过才会进入云端库。"}</p>
                            <ContributionPreview entry={draft} />
                            <button type="button" className="aqr-btn aqr-btn--primary" disabled={busy} onClick={() => void run(async () => {
                                const result = await submitContribution(draft);
                                if (mounted.current) { setSubmitted(true); setNotice(result.status === "published" ? "已发布到社区云端。" : "已提交，等待管理员审核。"); }
                                await refresh(false);
                            })}>确认提交这条 QR</button>
                            <p className="aqr-faint">网络异常时可点击同一按钮重试；插件会复用原请求编号，避免重复投稿。</p>
                        </section>}
                        <div className="aqr-remote-actions">
                            <button type="button" className="aqr-btn" disabled={busy} aria-pressed={!review} onClick={() => void run(() => refresh(false))}>我的提交</button>
                            {service.canReview && <button type="button" className="aqr-btn" disabled={busy} aria-pressed={review} onClick={() => void run(() => refresh(true))}>待审核</button>}
                        </div>
                        <div className="aqr-contribution-list">{items.map(item => <button key={item.id} type="button" className="aqr-btn" disabled={busy} onClick={() => void run(async () => {
                            setDetail(null); setReason("");
                            const next = await readSubmission(item.id); if (mounted.current) { setDetail(next); setReason(""); }
                        })}>{item.update ? "【修改】" : "【新增】"}{item.title} · {statusName[item.status]}</button>)}{!items.length && <p>暂无{review ? "待审核记录" : "提交记录"}。</p>}</div>
                        {detail && <section>
                            <p>{statusName[detail.status]}{detail.submitterId ? ` · 提交者 ${detail.submitterId}` : ""}</p>
                            {detail.update && <p className="aqr-banner is-info">这是一条云端修改申请，通过后替换原条目，不新增 QR。{detail.status === "pending" ? "审核前原内容仍可使用；若原条目已更新，系统会阻止旧修改覆盖。" : ""}</p>}
                            <ContributionPreview entry={detail.entry} />
                            {detail.reason && <p>审核说明：{detail.reason}</p>}
                            {review && service.canReview && detail.status === "pending" && <>
                                <label>审核说明（可选）<textarea className="aqr-input" value={reason} maxLength={500} disabled={busy} onChange={e => setReason(e.currentTarget.value)} /></label>
                                <div className="aqr-remote-actions">{(["approve", "reject"] as const).map(decision => <button type="button" key={decision} className={`aqr-btn ${decision === "approve" ? "aqr-btn--primary" : ""}`} disabled={busy} onClick={() => void run(async () => {
                                    const result = await reviewSubmission(detail.id, decision, reason);
                                    if (mounted.current) setNotice(result === "published" ? "已审核通过并发布。" : "已驳回该提交。");
                                    await refresh(true);
                                })}>{decision === "approve" ? "通过并发布" : "驳回"}</button>)}</div>
                            </>}
                        </section>}
                    </>}
            <button type="button" className="aqr-btn aqr-btn--ghost" disabled={busy} onClick={() => void run(() => refresh())}>{busy ? "处理中…" : "刷新贡献服务状态"}</button>
        </div>
    </Modal>;
}
