import { describe, it, expect } from 'vitest';
import { Argon2PasswordHasher } from './argon2-password-hasher';

describe('Argon2PasswordHasher: SEC-002準拠', () => {
  it('正しいpasswordはverify成功', async () => {
    const hasher = new Argon2PasswordHasher();
    const hash = await hasher.hash('correct-horse-battery-staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await hasher.verify('correct-horse-battery-staple', hash)).toBe(true);
  });

  it('誤ったpasswordはverify失敗', async () => {
    const hasher = new Argon2PasswordHasher();
    const hash = await hasher.hash('correct-horse-battery-staple');
    expect(await hasher.verify('wrong-password', hash)).toBe(false);
  });

  it('不正なhash文字列はverify失敗（例外を投げない）', async () => {
    const hasher = new Argon2PasswordHasher();
    expect(await hasher.verify('anything', 'not-a-valid-hash')).toBe(false);
  });

  it('8文字未満のpasswordはhash時に拒否', async () => {
    const hasher = new Argon2PasswordHasher();
    await expect(hasher.hash('short')).rejects.toThrow();
  });

  it('128文字超のpasswordはhash時に拒否', async () => {
    const hasher = new Argon2PasswordHasher();
    await expect(hasher.hash('a'.repeat(129))).rejects.toThrow();
  });
}, 20000);
