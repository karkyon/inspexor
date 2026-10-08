/**
 * fixture HTML → PDF（headless Chromium、A4）。日本語フォントは同梱の Noto Sans JP（@fontsource）を読み込み、
 * 端末のフォント有無に依存しない。外部ネットワークへの要求は遮断する（file: のみ許可）。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { AdapterError, type PdfRenderer } from '../ports';

const require = createRequire(import.meta.url);

function fontLinks(): string {
  return ['400', '700']
    .map((w) => `<link rel="stylesheet" href="${pathToFileURL(require.resolve(`@fontsource/noto-sans-jp/${w}.css`)).href}">`)
    .join('');
}

export class ChromiumPdfRenderer implements PdfRenderer {
  private browser: Browser | null = null;

  constructor(private readonly executablePath?: string) {}

  private async getBrowser(): Promise<Browser> {
    if (this.browser === null || !this.browser.isConnected()) {
      this.browser = await chromium.launch({ headless: true, ...(this.executablePath ? { executablePath: this.executablePath } : {}) });
    }
    return this.browser;
  }

  async render(html: string): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'inspexor-pdf-'));
    const file = join(dir, 'document.html');
    try {
      await writeFile(file, html.replace('</head>', `${fontLinks()}</head>`), 'utf8');
      const browser = await this.getBrowser();
      const page = await browser.newPage();
      try {
        await page.route('**/*', (route) => (route.request().url().startsWith('file:') ? route.continue() : route.abort()));
        await page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: 60_000 });
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
      } finally {
        await page.close();
      }
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      // ブラウザ起動失敗・timeout は一時障害として retry
      throw new AdapterError(`pdf render failed: ${String(error)}`, true, 'DEPENDENCY_UNAVAILABLE');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }
}
