/**
 * E2E 共通のログイン（CHG-012: 管理者の多要素認証に対応）。
 *   パスワードのあと、確認コードの画面が出たら:
 *     登録（初回）: 画面の秘密鍵を読み取り、確認コードを計算して登録 → 回復コードの保存を確認して続ける
 *     登録済み: 保存しておいた秘密鍵から確認コードを計算
 *   秘密鍵は dev-admin（E2E_LOGIN_ID）の分だけファイル E2E_ADMIN_TOTP_FILE（既定 ~/.inspexor-dev-admin-totp、権限 600）に保存し、
 *   E2E で作った管理者の分はメモリに持つ。同じ確認コード（30秒の区間）は2回使えないため、区間を進めて計算する。
 */
import { createHmac } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';

const MAIN_ADMIN = process.env['E2E_LOGIN_ID'] ?? 'dev-admin';
const TOTP_FILE = process.env['E2E_ADMIN_TOTP_FILE'] ?? join(homedir(), '.inspexor-dev-admin-totp');

interface TotpState {
  secret: string;
  lastStep: number;
}
const memory = new Map<string, TotpState>();

function load(loginId: string): TotpState | null {
  if (loginId !== MAIN_ADMIN) return memory.get(loginId) ?? null;
  if (!existsSync(TOTP_FILE)) return null;
  return JSON.parse(readFileSync(TOTP_FILE, 'utf8')) as TotpState;
}

function save(loginId: string, state: TotpState): void {
  if (loginId !== MAIN_ADMIN) {
    memory.set(loginId, state);
    return;
  }
  writeFileSync(TOTP_FILE, JSON.stringify(state), { mode: 0o600 });
  chmodSync(TOTP_FILE, 0o600);
}

function base32Decode(text: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/[\s=-]/g, '').toUpperCase()) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(secretBase32: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secretBase32)).update(msg).digest();
  const o = (mac[mac.length - 1] as number) & 0x0f;
  const bin = (((mac[o] as number) & 0x7f) << 24) | ((mac[o + 1] as number) << 16) | ((mac[o + 2] as number) << 8) | (mac[o + 3] as number);
  return String(bin % 1_000_000).padStart(6, '0');
}

/** 次に使える確認コード（使用済みの区間より後。前後1区間まで許されるので、必要なら少し待つ） */
export async function nextTotp(loginId: string, secretOverride?: string): Promise<string> {
  const state = secretOverride !== undefined ? { secret: secretOverride, lastStep: load(loginId)?.lastStep ?? 0 } : load(loginId);
  if (state === null) {
    throw new Error(
      `${loginId} の多要素認証の秘密鍵がありません（${TOTP_FILE}）。開発環境で ${loginId} の多要素認証を解除してから再実行してください: ` +
        `npx tsx --env-file=apps/web/.env.local apps/web/scripts/reset-mfa.ts ${loginId}`,
    );
  }
  const current = Math.floor(Date.now() / 30_000);
  let step = Math.max(current, state.lastStep + 1);
  if (step > current + 1) {
    await new Promise((r) => setTimeout(r, (step - 1) * 30_000 - Date.now() + 1500));
    step = Math.max(Math.floor(Date.now() / 30_000), state.lastStep + 1);
  }
  save(loginId, { secret: state.secret, lastStep: step });
  return hotp(state.secret, step);
}

/**
 * ログインボタンを押した後: 確認コードの画面が出たら（管理者の多要素認証）入力して進める。出なければ何もしない。
 * done はログイン後に表示されるもの（例: ようこそ…）
 */
export async function finishMfa(page: Page, loginId: string, done = page.getByText(/ようこそ、.+さん/)): Promise<void> {
  const mfaHeading = page.getByRole('heading', { name: /^(多要素認証の登録|確認コードの入力)$/ });
  await expect(mfaHeading.or(done).first()).toBeVisible({ timeout: 30_000 });
  if (!(await mfaHeading.isVisible())) return;
  if ((await mfaHeading.textContent()) === '多要素認証の登録') {
    const secret = ((await page.getByTestId('mfa-secret').textContent({ timeout: 30_000 })) ?? '').replace(/\s/g, '');
    save(loginId, { secret, lastStep: 0 });
    await page.getByLabel('確認コード（6桁）').fill(await nextTotp(loginId));
    await page.getByRole('button', { name: '登録してログイン' }).click();
    await expect(page.getByTestId('mfa-recovery-codes').getByRole('listitem')).toHaveCount(10);
    await page.getByLabel('回復コードを安全な場所に保存しました').check();
    await page.getByRole('button', { name: '続ける' }).click();
  } else {
    await page.getByLabel('確認コード（6桁）').fill(await nextTotp(loginId));
    await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  }
}

/** ログイン（必要なら確認コード）。CSRF token を返す */
export async function login(page: Page, loginId: string, password: string): Promise<string> {
  await page.goto('/login');
  await page.getByLabel('ログインID').fill(loginId);
  await page.getByLabel('パスワード').fill(password);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await finishMfa(page, loginId, page.getByText(/ようこそ、.+さん/));
  await expect(page).toHaveURL(/\/$/);
  return (await page.evaluate(() => window.sessionStorage.getItem('inspexor_csrf_token'))) ?? '';
}
