/* SPDX-License-Identifier: GPL-3.0-or-later */
export interface DiffLine { kind: "same" | "removed" | "added"; text: string; }

/** Line comparison with a bounded LCS table, even for text with thousands of newlines. */
export function diffLines(before: string, after: string): DiffLine[] {
    const a = before.split("\n"), b = after.split("\n");
    let prefix = 0, suffix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
    const old = a.slice(prefix, a.length - suffix), next = b.slice(prefix, b.length - suffix);
    const result: DiffLine[] = a.slice(0, prefix).map(text => ({ kind: "same", text }));
    if (old.length * next.length > 250_000) {
        result.push(...old.map(text => ({ kind: "removed" as const, text })), ...next.map(text => ({ kind: "added" as const, text })));
    } else {
        const width = next.length + 1;
        const lengths = new Uint16Array((old.length + 1) * width);
        for (let i = old.length - 1; i >= 0; i--) for (let j = next.length - 1; j >= 0; j--)
            lengths[i * width + j] = old[i] === next[j] ? lengths[(i + 1) * width + j + 1] + 1
                : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
        let i = 0, j = 0;
        while (i < old.length || j < next.length) {
            if (i < old.length && j < next.length && old[i] === next[j]) result.push({ kind: "same", text: old[i++] }), j++;
            else if (i < old.length && (j === next.length || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) result.push({ kind: "removed", text: old[i++] });
            else result.push({ kind: "added", text: next[j++] });
        }
    }
    result.push(...a.slice(a.length - suffix).map(text => ({ kind: "same" as const, text })));
    return result;
}
