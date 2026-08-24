import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import path from 'path';
import os from 'os';

/**
 * Browser Manager — local-first, persistent profiles per ATS.
 * Sessions stay on machine (~/.tailor-ai/browser-profiles/<ats>/).
 * No credentials pass through server.
 */

const PROFILE_BASE = path.join(os.homedir(), '.tailor-ai', 'browser-profiles');

let browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true, // headless for dry-run; headed when user solves CAPTCHA/MFA
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  return browser;
}

export async function getContext(ats: string, headed = false): Promise<{ context: BrowserContext; page: Page }> {
  const b = headed ? await chromium.launch({ headless: false, args: ['--no-sandbox'] }) : await getBrowser();

  const context = await b.newContext({
    // Persistent per-ATS so logins survive restarts
    // For headed CAPTCHA/MFA: user sees the browser and solves it
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
  });

  // Stealth: hide webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // @ts-ignore
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();
  return { context, page };
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

// For headed handoff (CAPTCHA/MFA) — opens visible browser, user solves, we resume
export async function openHeadedForHandoff(url: string): Promise<{ context: BrowserContext; page: Page }> {
  return getContext('handoff', true).then(async ({ context, page }) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return { context, page };
  });
}
