/**
 * INSPEXOR_セキュリティ・プライバシー・データ保護詳細仕様_v5.1.md SEC-002準拠。
 * Argon2id、8-128文字。漏えいpassword照合（HaveIBeenPwned等）は外部依存のため
 * 未実装・GAP（DEPENDENCY_UNAVAILABLE対応含め別途設計要）。
 *
 * module境界（開発スタック定義書 §5）準拠: provider SDK(argon2)を直接importしてよいのは
 * apps/web側のadapter層のみ。packages/application/@inspexor/domainはこのportを介して利用する。
 */
import * as argon2 from 'argon2';
import type { PasswordHasher } from '@inspexor/application';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export class Argon2PasswordHasher implements PasswordHasher {
  async hash(plainPassword: string): Promise<string> {
    if (plainPassword.length < PASSWORD_MIN_LENGTH || plainPassword.length > PASSWORD_MAX_LENGTH) {
      throw new Error(`passwordは${PASSWORD_MIN_LENGTH}〜${PASSWORD_MAX_LENGTH}文字である必要があります。`);
    }
    return argon2.hash(plainPassword, { type: argon2.argon2id });
  }

  async verify(plainPassword: string, hash: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plainPassword);
    } catch {
      // 不正なhash形式等はverify失敗として扱う（内部エラーを漏らさない、SEC-010準拠）
      return false;
    }
  }
}
