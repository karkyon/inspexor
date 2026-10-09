import { describe, it, expect } from 'vitest';
import { toJstParts } from '@inspexor/domain';
import {
  buildDeliveryDraft,
  buildWorkDraft,
  emptyDeliveryForm,
  emptyWorkForm,
  stepOfPath,
  validateDeliveryStep,
  validateWorkStep,
  workDetailToForm,
  type MasterLookup,
  type WorkForm,
  normalizeDeliveryForm,
  normalizeWorkForm,
} from './wizard';
import { clearAllDrafts, clearDraft, draftKey, loadDraft, resumeDrafts, saveDraft, type KeyValueStorage } from './draft-store';

const m: MasterLookup = {
  activeCustomer: (id) => id === 'c1',
  product: (id) => ({ pA: { customerId: 'c1', lotRequired: false }, pL: { customerId: 'c1', lotRequired: true }, pX: { customerId: 'c2', lotRequired: false } } as Record<string, { customerId: string; lotRequired: boolean }>)[id],
  workType: (id) => ({ wA: { productId: 'pA' }, wL: { productId: 'pL' } } as Record<string, { productId: string }>)[id],
  worker: (id) => id === 'w1' || id === 'w2',
  defectType: (id) => ({ d1: { productId: 'pA' } } as Record<string, { productId: string }>)[id],
  vehicle: (id) => id === 'v1',
  workLocation: (id) => id === 'l1',
};

const filled: WorkForm = {
  ...emptyWorkForm('2026-10-08', 'u1'),
  customerId: 'c1',
  productId: 'pA',
  workTypeId: 'wA',
  workerIds: ['w1', 'w2'],
  startTime: '13:00',
  endTime: '18:00',
  quantity: '1600',
  defects: { d1: '12' },
};

describe('作業 step 検証（SCR-06〜09）', () => {
  it('step ごとに必要な項目だけ検査する', () => {
    const f = emptyWorkForm('2026-10-08', 'u1');
    expect(validateWorkStep(1, f, m).map((i) => i.path)).toEqual(['/customerId']);
    expect(validateWorkStep(2, { ...f, customerId: 'c1' }, m).map((i) => i.path)).toEqual(['/productId', '/workTypeId']);
    expect(validateWorkStep(5, filled, m)).toEqual([]);
  });
  it('ロット必須品番・他社品番・作業内容不一致', () => {
    expect(validateWorkStep(2, { ...filled, productId: 'pL', workTypeId: 'wL' }, m).map((i) => i.code)).toEqual(['required']);
    expect(validateWorkStep(2, { ...filled, productId: 'pX' }, m).map((i) => i.code)).toEqual(['mismatch', 'mismatch']);
  });
  it('時間: 5分刻み・順序・未入力、終了0:00は翌日0:00として可', () => {
    expect(validateWorkStep(3, { ...filled, startTime: '13:03' }, m).map((i) => i.code)).toEqual(['step']);
    expect(validateWorkStep(3, { ...filled, startTime: '18:00', endTime: '13:00' }, m).map((i) => i.code)).toEqual(['order']);
    expect(validateWorkStep(3, { ...filled, endTime: '' }, m).map((i) => i.path)).toEqual(['/endAt']);
    expect(validateWorkStep(3, { ...filled, startTime: '20:00', endTime: '00:00' }, m)).toEqual([]);
    expect(validateWorkStep(3, { ...filled, workerIds: [] }, m).map((i) => i.path)).toEqual(['/workerIds']);
  });
  it('数量・不良: 不良合計>数量、整数以外', () => {
    expect(validateWorkStep(4, { ...filled, quantity: '10', defects: { d1: '11' } }, m).map((i) => i.code)).toEqual(['exceeds_quantity']);
    expect(validateWorkStep(4, { ...filled, quantity: '1.5' }, m).map((i) => i.path)).toEqual(['/quantity']);
    expect(validateWorkStep(4, { ...filled, defects: { d1: 'x' } }, m).map((i) => i.code)).toEqual(['type']);
  });
  it('API body: JST→UTC、終了0:00は翌日0:00、不良0件は送らない、ロット空は null', () => {
    const body = buildWorkDraft({ ...filled, startTime: '20:00', endTime: '00:00', defects: { d1: '0' }, lotNo: '  ' });
    expect(body).toMatchObject({ startAt: '2026-10-08T11:00:00.000Z', endAt: '2026-10-08T15:00:00.000Z', defects: [], lotNo: null, quantity: 1600 });
  });
  it('Detail → 画面値（再読込）', () => {
    const f = workDetailToForm(
      { workDate: '2026-10-08', reporterId: 'u1', customerId: 'c1', productId: 'pA', workTypeId: 'wA', lotNo: null, workerIds: ['w1'], startAt: '2026-10-08T04:00:00.000Z', endAt: '2026-10-08T15:00:00.000Z', quantity: 5, defects: [{ defectTypeId: 'd1', quantity: 1 }] },
      (iso) => toJstParts(new Date(iso)),
    );
    expect(f).toMatchObject({ startTime: '13:00', endTime: '00:00', quantity: '5', defects: { d1: '1' }, lotNo: '' });
    expect(buildWorkDraft(f).endAt).toBe('2026-10-08T15:00:00.000Z');
  });
});

describe('運搬 step 検証（SCR-03〜05）', () => {
  it('step1 必須・無効master、step2 品番1件以上・数量1〜999999・他社品番', () => {
    const f = emptyDeliveryForm('2026-10-08');
    expect(validateDeliveryStep(1, f, m).map((i) => i.path)).toEqual(['/driverId', '/customerId']);
    const ok = { ...f, driverId: 'w1', customerId: 'c1' };
    expect(validateDeliveryStep(2, ok, m).map((i) => i.path)).toEqual(['/items']);
    expect(validateDeliveryStep(2, { ...ok, items: { pA: '0', pX: '5' } }, m).map((i) => i.code)).toEqual(['range', 'mismatch']);
    expect(validateDeliveryStep(2, { ...ok, items: { pA: '999999' } }, m)).toEqual([]);
  });
  it('API body（使用車両・運搬回数・運搬費は CHG-004。運搬費の空欄は null）', () => {
    const base = { ...emptyDeliveryForm('2026-10-08'), driverId: 'w1', customerId: 'c1', items: { pA: '1200' } };
    expect(buildDeliveryDraft(base)).toEqual({
      deliveryDate: '2026-10-08', driverId: 'w1', customerId: 'c1', items: [{ productId: 'pA', quantity: 1200 }], vehicleId: null, tripCount: 1, deliveryFeeYen: null,
    });
    expect(buildDeliveryDraft({ ...base, vehicleId: 'v1', tripCount: '2', deliveryFee: '2,500' })).toMatchObject({ vehicleId: 'v1', tripCount: 2, deliveryFeeYen: 2500 });
  });
  it('CHG-004: 運搬回数 1〜99、運搬費は空欄か 0〜9,999,999、無効な車両', () => {
    const ok = { ...emptyDeliveryForm('2026-10-08'), driverId: 'w1', customerId: 'c1', items: { pA: '10' } };
    expect(validateDeliveryStep(2, ok, m)).toEqual([]);
    expect(validateDeliveryStep(2, { ...ok, tripCount: '0' }, m).map((i) => i.path)).toEqual(['/tripCount']);
    expect(validateDeliveryStep(2, { ...ok, tripCount: '100' }, m).map((i) => i.path)).toEqual(['/tripCount']);
    expect(validateDeliveryStep(2, { ...ok, deliveryFee: '-1' }, m).map((i) => i.path)).toEqual(['/deliveryFeeYen']);
    expect(validateDeliveryStep(2, { ...ok, deliveryFee: '10000000' }, m).map((i) => i.path)).toEqual(['/deliveryFeeYen']);
    expect(validateDeliveryStep(2, { ...ok, deliveryFee: '0' }, m)).toEqual([]);
    expect(validateDeliveryStep(1, { ...ok, vehicleId: 'vX' }, m).map((i) => i.path)).toEqual(['/vehicleId']);
    expect(stepOfPath('delivery', '/vehicleId')).toBe(1);
    expect(stepOfPath('delivery', '/deliveryFeeYen')).toBe(2);
  });
  it('CHG-004 以前の端末下書きは新項目を既定値で補う', () => {
    const old = { deliveryDate: '2026-10-08', driverId: 'w1', customerId: 'c1', items: {} } as unknown as Parameters<typeof normalizeDeliveryForm>[0];
    expect(normalizeDeliveryForm(old)).toMatchObject({ vehicleId: '', tripCount: '1', deliveryFee: '' });
    const oldWork = { ...emptyWorkForm('2026-10-08', 'u1') } as Record<string, unknown>;
    delete oldWork['remarks'];
    expect(normalizeWorkForm(oldWork as unknown as Parameters<typeof normalizeWorkForm>[0]).remarks).toBe('');
  });
  it('server error path → step', () => {
    expect(stepOfPath('delivery', '/items/0/productId')).toBe(2);
    expect(stepOfPath('work', '/lotNo')).toBe(2);
    expect(stepOfPath('work', '/endAt')).toBe(3);
    expect(stepOfPath('work', '/defects/0/defectTypeId')).toBe(4);
  });
});

class MemoryStorage implements KeyValueStorage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

describe('端末下書き（REQ-OFF-001）', () => {
  it('key 形式、保存→読込、24時間超で破棄', () => {
    const s = new MemoryStorage();
    expect(draftKey('u1', 'work')).toBe('inspexor:u1:work:draft:v1');
    const t0 = new Date('2026-10-08T00:00:00Z');
    expect(saveDraft('u1', 'work', { step: 2, data: { a: 1 }, serverId: null, serverVersion: null, reportNo: null }, t0, s)).toBe(true);
    expect(loadDraft('u1', 'work', new Date(t0.getTime() + 23 * 3600_000), s)?.step).toBe(2);
    expect(loadDraft('u1', 'work', new Date(t0.getTime() + 24 * 3600_000 + 1), s)).toBeNull();
    expect(s.length).toBe(0);
  });
  it('confirm で削除、logout で全削除（CSRF token 等の他 key は残す）', () => {
    const s = new MemoryStorage();
    const now = new Date();
    saveDraft('u1', 'work', { step: 1, data: {}, serverId: null, serverVersion: null, reportNo: null }, now, s);
    saveDraft('u1', 'delivery', { step: 1, data: {}, serverId: null, serverVersion: null, reportNo: null }, now, s);
    s.setItem('inspexor_csrf_token', 't');
    clearDraft('u1', 'work', s);
    expect(loadDraft('u1', 'work', now, s)).toBeNull();
    clearAllDrafts(s);
    expect(s.length).toBe(1);
    expect(s.getItem('inspexor_csrf_token')).toBe('t');
  });
  it('logout（clearAllDrafts）後は次のログイン確認まで保存しない（遅延保存による下書き復活の防止）', () => {
    const s = new MemoryStorage();
    clearAllDrafts(s);
    expect(saveDraft('u1', 'work', { step: 2, data: { a: 1 }, serverId: null, serverVersion: null, reportNo: null }, new Date(), s)).toBe(true);
    expect(s.getItem(draftKey('u1', 'work'))).toBeNull();
    resumeDrafts();
    expect(saveDraft('u1', 'work', { step: 2, data: { a: 1 }, serverId: null, serverVersion: null, reportNo: null }, new Date(), s)).toBe(true);
    expect(s.getItem(draftKey('u1', 'work'))).not.toBeNull();
  });
  it('壊れた JSON は null', () => {
    const s = new MemoryStorage();
    s.setItem(draftKey('u1', 'work'), '{');
    expect(loadDraft('u1', 'work', new Date(), s)).toBeNull();
  });
});
