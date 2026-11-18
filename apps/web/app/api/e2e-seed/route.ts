import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { createUser, DocUserRepository } from '@inspexor/docstore';
import { getDocStore } from '../../../lib/db/docstore';
import { MasterService } from '../../../lib/masters/master-service';
import { MASTER_DEFS, type MasterType } from '../../../lib/masters/definitions';
import { writeSchema } from '../../../lib/masters/schemas';

export const dynamic = 'force-dynamic';

/**
 * ブラウザ E2E 専用の初期データ投入（メモリ上の DocStore のときだけ。E2E_MEMORY_STORE=1 かつ APP_ENV が prod 以外）。
 * それ以外の環境では 404。利用者（ADMIN/OFFICE/FIELD/AUDITOR、パスワードは E2E_SEED_PASSWORD）と、在庫を管理する品番 MN139931 のマスタを作る。
 */
export async function POST(): Promise<Response> {
  if (process.env['E2E_MEMORY_STORE'] !== '1' || process.env['APP_ENV'] === 'prod') return new Response(null, { status: 404 });
  const password = process.env['E2E_SEED_PASSWORD'] ?? '';
  if (password.length < 8) return Response.json({ error: 'E2E_SEED_PASSWORD（8文字以上）が必要です' }, { status: 500 });
  const store = getDocStore();
  const now = new Date();
  const repo = new DocUserRepository(store);
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const ids: Record<string, string> = {};
  for (const [loginId, role, name] of [['e2e-admin', 'ADMIN', 'E2E管理者'], ['e2e-office', 'OFFICE', 'E2E事務'], ['e2e-field', 'FIELD', 'E2E現場'], ['e2e-auditor', 'AUDITOR', 'E2E監査']] as const) {
    if ((await repo.findByLoginId(loginId)) !== null) continue;
    const id = await createUser(store, { loginId, passwordHash: hash, displayName: name, roles: [role] }, now);
    if (id !== null) ids[loginId] = id;
  }
  const admin = await repo.findByLoginId('e2e-admin');
  const ctx = { actorId: admin?.id ?? 'e2e', correlationId: randomUUID(), now };
  const service = new MasterService(store);
  const make = async (type: MasterType, input: Record<string, unknown>): Promise<string> => (await service.create(type, writeSchema(MASTER_DEFS[type]).parse(input) as Record<string, unknown>, ctx)).id;
  const m: Record<string, string> = {};
  try {
    m['customer'] = await make('customers', { code: 'MARUGO', name: '丸五ゴム工業', closingDay: 31 });
    m['product'] = await make('products', { customerId: m['customer'], code: 'MN139931', name: 'パッキン（原紙）', settlementType: 'QUANTITY', inventoryManaged: true, unitsPerBox: 250, adjustStockManaged: true, adjustLowThreshold: 20 });
    m['workType'] = await make('work-types', { productId: m['product'], code: 'INSP', name: '検査' });
    m['defect'] = await make('defects', { productId: m['product'], code: 'D1', name: '破れ', sortOrder: 1 });
    m['worker'] = await make('workers', { code: 'E2W1', name: '在庫作業者' });
  } catch {
    // 2回目以降（既に投入済み）は何もしない
  }
  return Response.json({ users: ids, masters: m });
}
