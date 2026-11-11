import { Injectable } from "@nestjs/common";
import type { Frame, Locator, Page } from "playwright-core";
import { AspiAutomationError } from "./aspi-types";

/** Normalize Swagger labels without turning their example/help text into a field name. */
export function normalizedParameterName(entry: string): string {
  const cleaned = entry.replaceAll("\u200B", "").replace(/\s+/g, " ").trim();
  const label = cleaned.split(/\s*\*\s*|\s+required\b|\s+string\b|\s+\(header\)|\s+-\s+/i, 1)[0];
  return label.replace(/\s*-\s*/g, "-").replace(/\s+/g, "").toUpperCase();
}

type Scope = Page | Frame;
const optional = new Set([
  "AUTHORIZATION-CUSTOMER", "X-DEVICE-ID", "ORIGIN", "X-IP-ADDRESS",
  "X-LATITUDE", "X-LONGITUDE"
]);

@Injectable()
export class AspiFormResolver {
  async scope(page: Page): Promise<Scope> {
    if (await page.locator(".opblock:visible").count()) return page;
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame() && await frame.locator(".opblock:visible").count()) return frame;
    }
    throw new AspiAutomationError("FORM_NOT_READY", "Swagger Aplikasi Pengujian belum siap.", {
      iframeCount: page.frames().length - 1
    });
  }

  async operation(page: Page, path: string, method: string) {
    const scope = await this.scope(page);
    const operations = scope.locator(".opblock:visible");
    const available: string[] = [];
    for (let i = 0; i < await operations.count(); i++) {
      const item = operations.nth(i);
      const shown = ((await item.locator(".opblock-summary-path").textContent().catch(() => "")) ?? "")
        .replaceAll("\u200B", "").trim();
      const shownMethod = ((await item.locator(".opblock-summary-method").textContent().catch(() => "")) ?? "")
        .trim().toUpperCase();
      available.push(`${shownMethod} ${shown}`.trim());
      if (this.samePath(shown, path) && (!shownMethod || shownMethod === method.toUpperCase())) {
        return { scope, operation: item };
      }
    }
    throw new AspiAutomationError("FORM_NOT_READY", `Operasi ${method} ${path} tidak ditemukan.`, {
      availableOperations: available, iframeCount: page.frames().length - 1
    });
  }

  /** Swagger builds sometimes retain the 'Try it out' label after enabling fields. */
  async activateTryOut(operation: Locator, path: string): Promise<void> {
    const button = operation.locator("button.try-out__btn, .try-out button").first();
    const hasButton = await button.count() > 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      const label = hasButton ? ((await button.textContent().catch(() => "")) ?? "").trim() : "";
      // Swagger ASPI kadang mengabaikan klik pertama ketika operation baru selesai
      // dirender. Klik ulang secara terbatas hanya selama label masih "Try it out".
      if (hasButton && /^try\s*it\s*out$/i.test(label) && attempt % 4 === 0 &&
          await button.isVisible().catch(() => false) && await button.isEnabled().catch(() => false)) {
        await button.scrollIntoViewIfNeeded().catch(() => undefined);
        // Klik biasa tetap dipakai agar mengikuti lifecycle Swagger. Timeout
        // pendek mencegah satu overlay sementara menahan seluruh pengujian.
        await button.click({ timeout: 2500 }).catch(() => undefined);
      }

      const controls = await this.controls(operation);
      // Editor body dapat sudah editable sebelum parameter header aktif. Hanya
      // input/select parameter bernama yang membuktikan Try it out benar-benar aktif.
      for (const { control, names } of controls) {
        const tag = await control.evaluate(element => element.tagName.toLowerCase());
        if (tag !== "textarea" && names.length && !names.includes("CONTENT-TYPE") &&
            await control.isEditable().catch(() => false)) return;
      }
      // Endpoint body-only boleh lanjut setelah tombol berubah menjadi Cancel,
      // atau pada varian Swagger yang memang tidak mempunyai Try it out.
      const namedHeaderCount = (await Promise.all(controls.map(async ({control,names}) => ({
        tag: await control.evaluate(element => element.tagName.toLowerCase()), names
      })))).filter(item => item.tag !== "textarea" && item.names.length && !item.names.includes("CONTENT-TYPE")).length;
      if (!namedHeaderCount && (!hasButton || /^cancel$/i.test(label))) {
        const textarea = operation.locator("textarea:visible").first();
        if (await textarea.count() && await textarea.isEditable().catch(() => false)) return;
      }
      await operation.page().waitForTimeout(250);
    }
    throw new AspiAutomationError("FORM_NOT_READY", `Form ${path} belum editable setelah Try it out.`,
      await this.diagnostic(operation));
  }

  async fillParameter(operation: Locator, name: string, value: string) {
    const expected = normalizedParameterName(name);
    let controls = await this.controls(operation);
    let match = controls.find(item => item.names.includes(expected));
    if (!match) {
      if (expected === "CONTENT-TYPE" && value.toLowerCase() === "application/json") {
        return { state: "swagger-managed" as const };
      }
      if (optional.has(expected)) return { state: "optional-missing" as const };
      throw new AspiAutomationError("FORM_FIELD_NOT_FOUND", `Field ${name} tidak ditemukan pada form ASPI.`,
        await this.diagnostic(operation, { requested: name }));
    }

    if (!await match.control.isEditable().catch(() => false) && expected !== "CONTENT-TYPE") {
      // Swagger dapat merender ulang operation setelah aktivasi dan mengembalikan
      // tombol ke Try it out. Aktifkan ulang tepat sebelum mengisi header.
      const button = operation.locator("button.try-out__btn, .try-out button").first();
      const label = ((await button.textContent().catch(() => "")) ?? "").trim();
      if (/^try\s*it\s*out$/i.test(label)) {
        await this.activateTryOut(operation, name);
        controls = await this.controls(operation);
        match = controls.find(item => item.names.includes(expected));
      }
    }
    if (!match || !await match.control.isEditable().catch(() => false)) {
      if (expected === "CONTENT-TYPE" && value.toLowerCase() === "application/json") {
        return { state: "swagger-managed" as const };
      }
      throw new AspiAutomationError("FORM_FIELD_DISABLED", `Field ${name} tidak editable.`,
        await this.diagnostic(operation, { requested: name }));
    }

    if (await match.control.evaluate(element => element.tagName.toLowerCase() === "select")) {
      await match.control.selectOption({ label: value }).catch(() => match.control.selectOption(value));
    } else {
      await match.control.fill(value);
    }
    // Verify the field accepted the input; never print credential values.
    if (await match.control.inputValue().catch(() => value) !== value) {
      throw new AspiAutomationError("FORM_NOT_READY", `Field ${name} tidak mempertahankan nilai yang diisi.`,
        await this.diagnostic(operation, { requested: name }));
    }
    return { state: "filled" as const };
  }

  async fillBody(operation: Locator, body: Record<string, unknown>): Promise<void> {
    const editor = operation.locator("textarea.body-param__text:visible, .body-param textarea:visible, textarea:visible").last();
    if (!await editor.count()) throw new AspiAutomationError("FORM_FIELD_NOT_FOUND", "Editor request body tidak ditemukan.", await this.diagnostic(operation));
    if (!await editor.isEditable().catch(() => false)) throw new AspiAutomationError("FORM_FIELD_DISABLED", "Editor request body tidak editable.", await this.diagnostic(operation));
    const payload = JSON.stringify(body, null, 2);
    await editor.fill(payload);
    if (await editor.inputValue() !== payload) throw new AspiAutomationError("FORM_NOT_READY", "Request body gagal diisi pada editor ASPI.", await this.diagnostic(operation));
  }

  /** Form state only. Never expose actual user input, request bodies, or secrets. */
  async diagnostic(operation: Locator, extra: Record<string, unknown> = {}) {
    const fields: Record<string, unknown>[] = [];
    const controls = operation.locator("input:not([type='hidden']),textarea,select");
    for (let i = 0; i < await controls.count(); i++) {
      const item = controls.nth(i);
      fields.push({
        name: await item.getAttribute("name"),
        placeholder: await item.getAttribute("placeholder"),
        visible: await item.isVisible().catch(() => false),
        editable: await item.isEditable().catch(() => false),
        valuePresent: !!(await item.inputValue().catch(() => "")).trim(),
        valid: await item.evaluate((el: Element) => (el as HTMLInputElement).checkValidity?.() ?? true).catch(() => null)
      });
    }
    const button = operation.locator("button.try-out__btn, .try-out button").first();
    const label = ((await button.textContent().catch(() => "")) ?? "").trim();
    return { ...extra, tryItOutActive: /^cancel$/i.test(label), tryItOutLabel: label || null, fields };
  }

  private samePath(shown: string, expected: string): boolean {
    const normalize = (entry: string) => entry.replaceAll("\u200B", "").trim()
      .replace("/v1.0/", "/v1/").replace(/\/$/, "");
    return normalize(shown) === normalize(expected);
  }

  private async controls(operation: Locator): Promise<{control: Locator; names: string[]}[]> {
    const output: {control: Locator; names: string[]}[] = [];
    const controls = operation.locator("input:not([type='hidden']),textarea,select");
    for (let i = 0; i < await controls.count(); i++) {
      const control = controls.nth(i);
      if (!await control.isVisible().catch(() => false)) continue;
      const direct = [
        await control.getAttribute("name"), await control.getAttribute("placeholder"),
        await control.getAttribute("aria-label"), await control.getAttribute("data-param-name")
      ].filter((name): name is string => !!name);
      const row = control.locator("xpath=ancestor::*[self::tr or contains(@class,'parameter__item')][1]");
      const label = await row.count()
        ? await row.locator(".parameters-col_name,.parameter__name,label,dt,th,td:first-child").first()
          .textContent().catch(() => "") : "";
      output.push({ control, names: [...new Set([label, ...direct].filter((item): item is string => !!item)
        .map(normalizedParameterName).filter(Boolean))] });
    }
    return output;
  }
}
