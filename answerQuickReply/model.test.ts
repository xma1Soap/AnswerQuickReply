/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { imageByteLength, matchEntries, normalizeText, parseArchive, QR_LIMITS, QREntry, searchEntries, serializeArchive, validateEntry, validateImage } from "./model";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const image = { id: "example-image", name: "example.png", dataUrl: png };

function entry(overrides: Partial<QREntry> = {}): QREntry {
    return {
        id: "example", title: "网络排查", keywords: ["524"], weakKeywords: ["cloudflare"],
        content: "打开流式\n开关梯子，换节点", images: [], favorite: false, updatedAt: 1000, ...overrides
    };
}

function archive(entries: unknown[]): string {
    return JSON.stringify({ version: 1, entries });
}

test("normalization folds full width, case and whitespace", () => {
    assert.equal(normalizeText("  ＣＬＯＵＤＦＬＡＲＥ\n ５２４  "), "cloudflare 524");
    assert.equal(matchEntries([entry()], [{ text: "这是５２４报错", label: "正文" }])[0].score, 100);
});

test("numeric codes match only with numeric boundaries", () => {
    for (const text of ["1524", "5240", "１５２４", "١524٢", "5\n24", "５\n２４"]) {
        assert.equal(matchEntries([entry()], [{ text, label: "正文" }]).length, 0, text);
    }
    for (const text of ["524", "errorcode_524", "HTTP 524: timeout", "报错524怎么办"]) {
        assert.equal(matchEntries([entry()], [{ text, label: "正文" }]).length, 1, text);
    }
});

test("repeated triggers and duplicated OCR evidence never boost the score", () => {
    const qr = entry({ keywords: ["524", "５２４"], weakKeywords: ["524", "cloudflare"] });
    const single = matchEntries([qr], [{ text: "524 cloudflare", label: "正文" }])[0];
    const repeated = matchEntries([qr], [{ text: "524 524 cloudflare cloudflare", label: "正文" }, { text: "524 cloudflare", label: "图片1" }])[0];
    assert.equal(single.score, repeated.score);
    assert.deepEqual(single.reasons, repeated.reasons);
    assert.equal(single.reasons.length, 2);
});

test("specific error evidence outranks weak words even with many weak hits", () => {
    const qr = entry({ keywords: ["524"], weakKeywords: ["cloudflare", "timeout", "network", "error", "失败", "重试"] });
    const weak = matchEntries([qr], [{ text: "cloudflare timeout network error 失败 重试", label: "图片" }])[0];
    const strong = matchEntries([qr], [{ text: "524", label: "正文" }])[0];
    assert.ok(weak.score < 100);
    assert.ok(strong.score >= 100);
    assert.ok(strong.score > weak.score);
});

test("OCR matching tolerates phrase line breaks and mid-word wrapping", () => {
    const qr = entry({ keywords: ["A timeout occurred", "errorcode_524"] });
    for (const text of ["A timeout\n occurred", "A time\nout oc\ncurred", "errorcode_\n524"]) {
        assert.ok(matchEntries([qr], [{ text, label: "图片1" }])[0]?.score >= 100, text);
    }
});

test("literal keyword punctuation does not become regular expression syntax", () => {
    const qr = entry({ keywords: ["[ERR].*"] });
    assert.equal(matchEntries([qr], [{ text: "[ERR].*", label: "正文" }]).length, 1);
    assert.equal(matchEntries([qr], [{ text: "ERR anything", label: "正文" }]).length, 0);
});

test("manual search includes title and reply content and requires all terms", () => {
    const entries = [entry(), entry({ id: "other", title: "安装指导", keywords: [], weakKeywords: [], content: "安装程序" })];
    assert.deepEqual(searchEntries(entries, "网络 流式").map(item => item.id), ["example"]);
    assert.deepEqual(searchEntries(entries, "安装 流式"), []);
    assert.equal(searchEntries(entries, " ").length, 2);
});

test("archive round trip preserves real image bytes and mixed reply content", () => {
    const original = entry({ images: [image], sourceUrl: "https://discord.com/channels/1/2/3" });
    assert.deepEqual(parseArchive(serializeArchive([original])).entries, [original]);
    assert.equal(imageByteLength(png), Buffer.from(png.split(",")[1], "base64").length);
});

test("import requires version 1 and complete, bounded entry fields", () => {
    const badArchives = ["not JSON", "null", "[]", JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: [], surprise: true })];
    for (const value of badArchives) assert.throws(() => parseArchive(value));
    const badEntries = [
        entry({ title: "" }), entry({ title: "a".repeat(QR_LIMITS.title + 1) }),
        entry({ content: "" }), entry({ content: "a".repeat(QR_LIMITS.content + 1) }),
        entry({ updatedAt: -1 }), entry({ updatedAt: NaN }), entry({ favorite: "yes" as unknown as boolean }),
        entry({ keywords: [42] as unknown as string[] }), entry({ keywords: ["a".repeat(QR_LIMITS.keywordLength + 1)] }),
        entry({ keywords: Array(QR_LIMITS.keywords + 1).fill("x") }), entry({ sourceUrl: "javascript:alert(1)" }),
        entry({ sourceUrl: "https://user:secret@example.com" }), entry({ images: [image, image] }),
        entry({ id: "bad/id" }), { ...entry(), unknown: "not accepted" }
    ];
    for (const value of badEntries) assert.throws(() => parseArchive(archive([value])));
    assert.throws(() => parseArchive(archive([entry(), entry()])));
    assert.throws(() => parseArchive(archive(Array.from({ length: QR_LIMITS.entries + 1 }, (_, n) => entry({ id: `qr-${n}` })))));
    assert.equal(parseArchive(archive([])).entries.length, 0);
    assert.equal(validateEntry(entry({ content: "", images: [image] })).images.length, 1);
});

test("image validation rejects external URLs, SVG, mismatched MIME and malformed Base64", () => {
    const invalidData = [
        "https://cdn.discordapp.com/attachments/image.png", "data:image/svg+xml;base64,PHN2Zy8+",
        png.replace("image/png", "image/jpeg"), "data:image/png;base64,%%%", "data:image/png;base64,",
        "data:image/png;base64,AAAA=A==", "data:image/png;base64,AAAA===", "data:image/png;base64,AB==",
        "data:image/png;base64,AAB=", png.replace(",", ",\n"), "data:image/png;base64,AAAA"
    ];
    for (const dataUrl of invalidData) assert.throws(() => validateImage({ ...image, dataUrl }), dataUrl);
    assert.deepEqual(validateImage(image), image);
});

test("image and library byte budgets reject excessive data", () => {
    const bytes = Buffer.alloc(QR_LIMITS.imageBytes + 1);
    bytes.set(Buffer.from("89504e470d0a1a0a", "hex"));
    assert.throws(() => validateImage({ ...image, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` }), /10 MiB/);
    const image10 = { ...image, dataUrl: `data:image/png;base64,${bytes.subarray(0, QR_LIMITS.imageBytes).toString("base64")}` };
    assert.equal(imageByteLength(validateImage(image10).dataUrl), QR_LIMITS.imageBytes);
    assert.throws(() => parseArchive(archive([entry({ images: Array.from({ length: 7 }, (_, n) => ({ ...image10, id: `image-${n}` })) })])), /64 MiB|过大/);
});
