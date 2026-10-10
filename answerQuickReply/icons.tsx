/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Path data only. JSX must not be created at module load, because Discord's
// React is not available yet when Vencord evaluates plugin modules.
const ICONS = {
    search: ["M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z", "m15.2 15.2 4.3 4.3"],
    plus: ["M12 5v14", "M5 12h14"],
    x: ["M6.5 6.5l11 11", "M17.5 6.5l-11 11"],
    star: ["M12 3.8l2.45 5 5.5.8-3.98 3.88.94 5.47L12 16.36l-4.91 2.59.94-5.47L4.05 9.6l5.5-.8L12 3.8Z"],
    edit: ["M4.5 19.5h3.8L18.6 9.2a2.1 2.1 0 0 0 0-3L17.8 5.4a2.1 2.1 0 0 0-3 0L4.5 15.7v3.8Z", "M13.5 6.7l3.8 3.8"],
    trash: ["M4.5 7h15", "M9.5 7V5.2c0-.66.54-1.2 1.2-1.2h2.6c.66 0 1.2.54 1.2 1.2V7", "M6.5 7l.85 11.1c.08 1.06.96 1.9 2.03 1.9h5.24c1.07 0 1.95-.84 2.03-1.9L17.5 7", "M10.5 11v5", "M13.5 11v5"],
    reply: ["M9.5 7.5 5 12l4.5 4.5", "M5.5 12h8a5 5 0 0 1 5 5v1.5"],
    import: ["M12 4v10.5", "m7.75 10.5 4.25 4.25 4.25-4.25", "M4.5 15.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2"],
    export: ["M12 15V4.5", "m7.75 8.75 4.25-4.25 4.25 4.25", "M4.5 15.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2"],
    image: ["M6 4.5h12A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V6A1.5 1.5 0 0 1 6 4.5Z", "M10.5 9.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z", "m19.5 15-4.5-4.5-9.5 9"],
    scan: ["M4.5 8.5V6A1.5 1.5 0 0 1 6 4.5h2.5", "M15.5 4.5H18A1.5 1.5 0 0 1 19.5 6v2.5", "M19.5 15.5V18a1.5 1.5 0 0 1-1.5 1.5h-2.5", "M8.5 19.5H6A1.5 1.5 0 0 1 4.5 18v-2.5", "M8 10h8", "M8 14h5"],
    link: ["M13.5 4.5h6v6", "M19.5 4.5 11 13", "M17.5 13.5v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h4"],
    check: ["m5.5 12.5 4 4 9-9"],
    spark: ["M12 3.5c.4 3.9 2.1 5.6 6 6-3.9.4-5.6 2.1-6 6-.4-3.9-2.1-5.6-6-6 3.9-.4 5.6-2.1 6-6Z", "M18.5 15.5c.2 1.5.8 2.1 2.3 2.3-1.5.2-2.1.8-2.3 2.3-.2-1.5-.8-2.1-2.3-2.3 1.5-.2 2.1-.8 2.3-2.3Z"],
    chevron: ["m7 10 5 5 5-5"],
    bell: ["M6.5 16.5v-5a5.5 5.5 0 0 1 11 0v5l1.5 2h-14l1.5-2Z", "M10 20.5a2 2 0 0 0 4 0"],
    inbox: ["M4.5 13.5 6.8 6.3A2.5 2.5 0 0 1 9.2 4.5h5.6a2.5 2.5 0 0 1 2.4 1.8l2.3 7.2", "M4.5 13.5h4l1.2 2h4.6l1.2-2h4v4a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-4Z"],
    layers: ["M12 4 3.5 8.5 12 13l8.5-4.5L12 4Z", "m3.5 12.5 8.5 4.5 8.5-4.5", "m3.5 16.5 8.5 4.5 8.5-4.5"],
    bolt: ["M13.5 3.5 6 13.5h5.5l-1 7 7.5-10h-5.5l1-7Z"]
} as const;

export type IconName = keyof typeof ICONS;

interface IconProps {
    name: IconName;
    size?: number;
    filled?: boolean;
    className?: string;
}

export function Icon({ name, size = 16, filled, className }: IconProps) {
    return <svg
        className={className ? `aqr-icon ${className}` : "aqr-icon"}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
    >
        {ICONS[name].map(d => <path key={d} d={d} />)}
    </svg>;
}
