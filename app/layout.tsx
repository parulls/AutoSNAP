import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AutoSNAP — API Testing",
  description: "Sistem pengujian API SNAP untuk QA dan developer.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Browser extensions can add attributes to body before React hydrates it.
  return <html lang="id"><body suppressHydrationWarning>{children}</body></html>;
}
