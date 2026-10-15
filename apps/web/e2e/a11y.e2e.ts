import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login } from './auth';

// CHG-012 E2E: アクセシビリティ（NFR-006 WCAG 2.1 AA の主要項目）。主要画面を axe で検査し、違反 0 件。
// キーボード: 最初の Tab で「本文へ移動」、Enter で本文へ。ログイン画面は見出し・ラベル付き。
const PW = { admin: process.env['E2E_PASSWORD'] ?? '', field: process.env['E2E_FIELD_PASSWORD'] ?? '', office: process.env['E2E_OFFICE_PASSWORD'] ?? '' };

async function violations(page: Page): Promise<string[]> {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return r.violations.map((v) => `${v.id}（${v.impact}）: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' / ')}`);
}

test.describe('CHG-012 E2E: アクセシビリティ', () => {
  test.beforeAll(() => {
    if (PW.admin === '' || PW.field === '' || PW.office === '') throw new Error('E2E_PASSWORD / E2E_FIELD_PASSWORD / E2E_OFFICE_PASSWORD が未設定です');
  });

  test('ログイン・事務所・現場の主要画面に WCAG 2.1 AA の違反がない。最初の Tab は「本文へ移動」', async ({ browser }) => {
    test.setTimeout(300_000);
    const anon = await (await browser.newContext()).newPage();
    await anon.goto('/login');
    await expect(anon.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await violations(anon), 'ログイン').toEqual([]);

    const admin = await (await browser.newContext()).newPage();
    await login(admin, process.env['E2E_LOGIN_ID'] ?? 'dev-admin', PW.admin);
    const features = ((await (await admin.request.get('/api/v1/me')).json()) as { data: { features: Record<string, boolean> } }).data.features;
    const adminPages = ['/admin/records', '/admin/monthly', '/admin/masters/products', '/admin/masters/customers', '/admin/users', '/admin/users/new'];
    if (features['approval'] === true) adminPages.push('/admin/dashboard');
    if (features['billing'] === true) adminPages.push('/admin/billing');
    if (features['adminMfa'] === true) adminPages.push('/admin/account');
    for (const p of adminPages) {
      await admin.goto(p);
      await expect(admin.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await violations(admin), p).toEqual([]);
    }
    await admin.goto('/admin/records');
    await admin.keyboard.press('Tab');
    await expect(admin.locator(':focus')).toHaveText('本文へ移動');
    await admin.keyboard.press('Enter');
    await expect(admin.locator('#main')).toBeFocused();

    const field = await (await browser.newContext()).newPage();
    await login(field, process.env['E2E_FIELD_LOGIN_ID'] ?? 'dev-field', PW.field);
    for (const p of ['/field', '/field/work-reports/new', '/field/deliveries/new']) {
      await field.goto(p);
      await expect(field.getByRole('heading', { level: 1 }).first()).toBeVisible();
      expect(await violations(field), p).toEqual([]);
    }

    const office = await (await browser.newContext()).newPage();
    await login(office, process.env['E2E_OFFICE_LOGIN_ID'] ?? 'dev-office', PW.office);
    await office.goto('/field/work-reports/new');
    await office.getByLabel('報告者').selectOption({ index: 1 });
    expect(await violations(office), '代理入力').toEqual([]);
  });
});
