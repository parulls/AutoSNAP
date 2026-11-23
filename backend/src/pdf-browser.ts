import { existsSync } from "node:fs";
import { chromium, firefox, type Browser, type BrowserContext, type Page } from "playwright-core";

/** Engine that actually draws the ASPI html2pdf page. A User-Agent string alone does not change this. */
export type PdfBrowserKind = "firefox" | "edge" | "chrome";

/** Window the operator is using. html2pdf lays out #printPdf from these CSS pixels and the device scale. */
export type PdfCaptureProfile = {
  kind: PdfBrowserKind;
  userAgent?: string;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
};

export function pdfBrowserFromUserAgent(userAgent: string | undefined): PdfBrowserKind {
  const ua = userAgent ?? "";
  if (/Edg\//i.test(ua)) return "edge";
  if (/Firefox\//i.test(ua)) return "firefox";
  return "chrome";
}

export function pdfCaptureProfile(userAgent: string | undefined, screen: unknown): PdfCaptureProfile {
  const box = screen && typeof screen === "object" ? screen as { width?: unknown; height?: unknown; deviceScaleFactor?: unknown } : {};
  const width = Number(box.width);
  const height = Number(box.height);
  const deviceScaleFactor = Number(box.deviceScaleFactor);
  return {
    kind: pdfBrowserFromUserAgent(userAgent),
    userAgent: userAgent?.replace("HeadlessChrome", "Chrome"),
    ...(width >= 800 && width <= 3840 ? { width: Math.round(width) } : {}),
    ...(height >= 600 && height <= 2400 ? { height: Math.round(height) } : {}),
    ...(deviceScaleFactor >= 1 && deviceScaleFactor <= 3 ? { deviceScaleFactor } : {}),
  };
}

function firstExisting(paths: Array<string | undefined>) {
  return paths.filter(Boolean).find(path => existsSync(path!));
}

/**
 * Draw the ASPI Download page in its own browser, sized like the operator's window.
 * The testing Chrome stays at its automation viewport and is not used to paint the PDF.
 */
export async function openPdfCaptureBrowser(profile: PdfCaptureProfile, source: Page): Promise<{ page: Page; close: () => Promise<void> }> {
  if (process.env.VERCEL && profile.kind !== "chrome") {
    throw Error(`Pengambilan PDF di Vercel hanya punya Chromium. Browser Anda ${profile.kind}, jadi layout tidak bisa disamakan di deployment itu.`);
  }
  const width = profile.width ?? 1280;
  const height = profile.height ?? 800;
  const deviceScaleFactor = profile.deviceScaleFactor ?? 1;
  const cookies = await source.context().cookies("https://apidevportal.aspi-indonesia.or.id");
  let browser: Browser;
  try {
    if (profile.kind === "firefox") browser = await firefox.launch({ headless: true });
    else if (profile.kind === "edge") {
      const executablePath = firstExisting([
        process.env.AUTOSNAP_EDGE_PATH?.trim(),
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      ]);
      if (!executablePath) throw Error("Microsoft Edge tidak ditemukan. PDF tidak dialihkan ke Chrome.");
      browser = await chromium.launch({ executablePath, headless: true });
    } else {
      const executablePath = firstExisting([
        process.env.AUTOSNAP_CHROME_PATH?.trim(),
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ]);
      if (!executablePath) throw Error("Google Chrome tidak ditemukan untuk menggambar PDF. PDF tidak diganti dengan Chromium lain.");
      browser = await chromium.launch({ executablePath, headless: true, args: ["--disable-blink-features=AutomationControlled"] });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const hint = profile.kind === "firefox" ? " Pasang mesin Firefox Playwright: npx playwright install firefox." : "";
    throw Error(`Browser ${profile.kind} untuk PDF ASPI gagal dibuka.${hint} AutoSNAP tidak mengganti ke browser lain. ${detail.slice(0, 240)}`);
  }
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width, height },
      deviceScaleFactor,
      ...(profile.userAgent ? { userAgent: profile.userAgent } : {}),
      colorScheme: "light",
    });
    if (cookies.length) {
      await context.addCookies(cookies.map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      })));
    }
    const page = await context.newPage();
    const close = async () => {
      await context?.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    };
    return { page, close };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    throw error;
  }
}
