// EXT-02（実master）未提供時の deterministic synthetic seed（MVP開発計画 §外部入力）。APP_ENV=local/dev 限定。
// 何度実行しても同じ状態になる（既存 code はスキップ）。値はすべて合成値。
//   node --env-file=.env.local scripts/seed-masters.mjs
import pg from 'pg';

if (!['local', 'dev'].includes(process.env.APP_ENV ?? '')) {
  console.error(`APP_ENV=${process.env.APP_ENV ?? '(未設定)'} のため中止（local/devのみ）`);
  process.exit(1);
}
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const one = async (sql, params) => (await c.query(sql, params)).rows[0];
try {
  await c.query('BEGIN');
  await c.query(`INSERT INTO app.customers(code,name,closing_day) VALUES ('SYN-C01','合成顧客A',31) ON CONFLICT (code) DO NOTHING`);
  const customer = await one(`SELECT id FROM app.customers WHERE code='SYN-C01'`);

  // 運搬按分対象4品目（DEC-002: 1報告=1便=2,500円）＋ 時間精算1品目
  const products = [
    ['SYN-P01', '合成品番01（運搬対象）', 'QUANTITY', 'ALLOCATED'],
    ['SYN-P02', '合成品番02（運搬対象）', 'QUANTITY', 'ALLOCATED'],
    ['SYN-P03', '合成品番03（運搬対象）', 'QUANTITY', 'ALLOCATED'],
    ['SYN-P04', '合成品番04（運搬対象）', 'QUANTITY', 'ALLOCATED'],
    ['SYN-P05', '合成品番05（時間精算）', 'TIME', 'NONE'],
  ];
  const productIds = [];
  for (const [code, name, settlement, transport] of products) {
    await c.query(
      `INSERT INTO app.products(customer_id,code,name,settlement_type) VALUES ($1,$2,$3,$4) ON CONFLICT (customer_id,code) DO NOTHING`,
      [customer.id, code, name, settlement],
    );
    const p = await one(`SELECT id FROM app.products WHERE customer_id=$1 AND code=$2`, [customer.id, code]);
    productIds.push(p.id);
    await c.query(`INSERT INTO app.work_types(product_id,code,name) VALUES ($1,'INSP','検査') ON CONFLICT (product_id,code) DO NOTHING`, [p.id]);
    for (const [i, [dcode, dname]] of [['D01', 'バリ'], ['D02', '欠け']].entries()) {
      await c.query(
        `INSERT INTO app.defect_types(product_id,code,name,sort_order) VALUES ($1,$2,$3,$4) ON CONFLICT (product_id,code) DO NOTHING`,
        [p.id, dcode, dname, i + 1],
      );
    }
    const unitPrice = settlement === 'TIME' ? '3000' : '12.5';
    await c.query(
      `INSERT INTO app.rate_rules(product_id,unit_price,valid_from)
       SELECT $1,$2,'2026-01-01' WHERE NOT EXISTS (SELECT 1 FROM app.rate_rules WHERE product_id=$1 AND active)`,
      [p.id, unitPrice],
    );
    await c.query(
      `INSERT INTO app.transport_rules(product_id,type,amount_yen,allocation_group,valid_from)
       SELECT $1,$2::app.transport_type,$3,$4,'2026-01-01' WHERE NOT EXISTS (SELECT 1 FROM app.transport_rules WHERE product_id=$1 AND active)`,
      [p.id, transport, transport === 'ALLOCATED' ? 2500 : 0, transport === 'ALLOCATED' ? 'SYN-4ITEMS' : null],
    );
  }
  for (const [code, name] of [['SYN-W01', '合成作業者1'], ['SYN-W02', '合成作業者2'], ['SYN-W03', '合成運転者']]) {
    await c.query(`INSERT INTO app.workers(code,name) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING`, [code, name]);
  }
  await c.query(
    `INSERT INTO app.customer_contacts(customer_id,code,name,email,send_daily,send_invoice)
     VALUES ($1,'SYN-K01','合成担当者','synthetic-contact@example.com',true,true) ON CONFLICT (customer_id,code) DO NOTHING`,
    [customer.id],
  );
  const contact = await one(`SELECT id FROM app.customer_contacts WHERE customer_id=$1 AND code='SYN-K01'`, [customer.id]);
  for (const pid of productIds) {
    for (const purpose of ['DAILY', 'INVOICE']) {
      await c.query(`INSERT INTO app.product_contacts(product_id,contact_id,purpose) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [pid, contact.id, purpose]);
    }
  }
  // 合成休日（請求の休日割増検証用。実運用値は EXT-02 で置換）
  for (const [d, name] of [['2026-01-01', '合成休日（元日）'], ['2026-05-04', '合成休日'], ['2026-11-03', '合成休日']]) {
    await c.query(`INSERT INTO app.holidays(holiday_date,name) VALUES ($1,$2) ON CONFLICT (holiday_date) DO NOTHING`, [d, name]);
  }
  await c.query('COMMIT');
  const counts = await c.query(`SELECT
    (SELECT count(*) FROM app.customers) customers, (SELECT count(*) FROM app.products) products,
    (SELECT count(*) FROM app.work_types) work_types, (SELECT count(*) FROM app.defect_types) defects,
    (SELECT count(*) FROM app.rate_rules) rates, (SELECT count(*) FROM app.transport_rules) transport,
    (SELECT count(*) FROM app.workers) workers, (SELECT count(*) FROM app.customer_contacts) contacts,
    (SELECT count(*) FROM app.holidays) holidays`);
  console.log('seed 完了:', counts.rows[0]);
} catch (error) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('seed 失敗:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await c.end();
}
