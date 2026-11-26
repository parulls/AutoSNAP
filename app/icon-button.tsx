"use client";

import type { ButtonHTMLAttributes } from "react";
import UiIcon from "./ui-icon";

export type IconAction = "add" | "edit" | "delete" | "refresh" | "detail" | "search" | "link" | "close";

const labels: Record<IconAction, string> = {
  add: "Tambah",
  edit: "Edit",
  delete: "Hapus",
  refresh: "Muat ulang",
  detail: "Detail",
  search: "Cari",
  link: "Tautkan",
  close: "Tutup",
};

const icons: Record<IconAction, Parameters<typeof UiIcon>[0]["name"]> = {
  add: "plus",
  edit: "edit",
  delete: "trash",
  refresh: "refresh",
  detail: "detail",
  search: "search",
  link: "link",
  close: "close",
};

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  action: IconAction;
  label?: string;
  tone?: "default" | "primary" | "danger";
  showLabel?: boolean;
};

export default function IconButton({ action, label, tone = "default", showLabel = false, className = "", title, "aria-label": ariaLabel, ...rest }: Props) {
  const text = label ?? labels[action];
  const toneClass = tone === "primary" ? "icon-button primary" : tone === "danger" ? "icon-button danger" : "icon-button";
  return (
    <button
      type="button"
      className={`${toneClass}${showLabel ? " with-label" : ""} ${className}`.trim()}
      title={title ?? text}
      aria-label={ariaLabel ?? text}
      {...rest}
    >
      <UiIcon name={icons[action]} width={16} height={16} />
      {showLabel && <span>{text}</span>}
    </button>
  );
}
