import { describe, it, expect } from 'vitest';
import { OPERATION_POLICIES, authorizeOperation, type OperationId, type RoleCode } from './rbac';

const ALL = Object.keys(OPERATION_POLICIES) as OperationId[];
const as = (...roles: RoleCode[]) => ({ roles });

describe('rbac: API設計書 §6 認証/権限 準拠', () => {
  it('37 operation（API-001〜025＋CHG-004 API-026〜028＋CHG-007 API-029＋CHG-008 API-030〜033＋CHG-009 API-034＋CHG-011 API-035〜037）を網羅し apiId が一意', () => {
    expect(ALL).toHaveLength(37);
    const ids = ALL.map((op) => OPERATION_POLICIES[op].apiId);
    expect(new Set(ids).size).toBe(37);
    expect([...ids].sort()).toEqual(Array.from({ length: 37 }, (_, i) => `API-${String(i + 1).padStart(3, '0')}`));
  });

  it('CHG-004: setDeliveryFee は OFFICE/ADMIN のみ', () => {
    expect(authorizeOperation('setDeliveryFee', { roles: ['OFFICE'] }).ok).toBe(true);
    expect(authorizeOperation('setDeliveryFee', { roles: ['ADMIN'] }).ok).toBe(true);
    expect(authorizeOperation('setDeliveryFee', { roles: ['FIELD'] })).toEqual({ ok: false, errorCode: 'FORBIDDEN' });
    expect(authorizeOperation('setDeliveryFee', { roles: ['AUDITOR'] })).toEqual({ ok: false, errorCode: 'FORBIDDEN' });
  });

  it('CHG-004: 月次集計・出力は OFFICE/ADMIN/AUDITOR、FIELD は不可', () => {
    for (const op of ['getMonthlySummary', 'exportMonthlySummary'] as const) {
      expect(authorizeOperation(op, { roles: ['AUDITOR'] }).ok).toBe(true);
      expect(authorizeOperation(op, { roles: ['FIELD'] })).toEqual({ ok: false, errorCode: 'FORBIDDEN' });
    }
  });

  it('PUBLIC（login）は未認証でも可', () => {
    expect(authorizeOperation('login', null)).toEqual({ ok: true, ownerCheckRequired: false });
  });

  it.each(ALL.filter((op) => op !== 'login'))('%s は未認証なら AUTH_REQUIRED', (op) => {
    expect(authorizeOperation(op, null)).toEqual({ ok: false, errorCode: 'AUTH_REQUIRED' });
  });

  it('ADMIN専用（createMaster/updateMaster/deactivateMaster）は OFFICE/FIELD/AUDITOR を拒否', () => {
    for (const op of ['createMaster', 'updateMaster', 'deactivateMaster'] as const) {
      expect(authorizeOperation(op, as('ADMIN')).ok).toBe(true);
      for (const role of ['OFFICE', 'FIELD', 'AUDITOR'] as const) {
        expect(authorizeOperation(op, as(role))).toEqual({ ok: false, errorCode: 'FORBIDDEN' });
      }
    }
  });

  it('AUDITORは閲覧系（listRecords/getBillingRun/getInvoice）のみ可、command系は拒否', () => {
    for (const op of ['listRecords', 'getBillingRun', 'getInvoice'] as const) {
      expect(authorizeOperation(op, as('AUDITOR')).ok).toBe(true);
    }
    for (const op of ['createBillingRun', 'transitionBillingRun', 'transitionInvoice', 'documentAction', 'createWorkReport', 'createDeliveryReport'] as const) {
      expect(authorizeOperation(op, as('AUDITOR'))).toEqual({ ok: false, errorCode: 'FORBIDDEN' });
    }
    // transitionRecord は owner 型（CHG-007）: ロール外は所有者確認が必要（AUDITOR は報告を持たないため対象で拒否される）
    expect(authorizeOperation('transitionRecord', as('AUDITOR'))).toEqual({ ok: true, ownerCheckRequired: true });
  });

  it('FIELDは承認・請求・帳票操作を拒否', () => {
    for (const op of ['createBillingRun', 'getInvoice', 'documentAction', 'getDashboard'] as const) {
      expect(authorizeOperation(op, as('FIELD'))).toEqual({ ok: false, errorCode: 'FORBIDDEN' });
    }
    // 差戻しされた自分の報告の revise だけ（handler/service で owner・操作・状態を確認）
    expect(authorizeOperation('transitionRecord', as('FIELD'))).toEqual({ ok: true, ownerCheckRequired: true });
  });

  it('CHG-002: FIELD は listRecords 可（自分の履歴。owner 絞込みは repository）', () => {
    expect(authorizeOperation('listRecords', as('FIELD'))).toEqual({ ok: true, ownerCheckRequired: false });
  });

  it('owner/OFFICE 型: OFFICEは即可、FIELDは所有者判定が必要', () => {
    for (const op of ['updateWorkReport', 'confirmWorkReport', 'updateDeliveryReport', 'confirmDeliveryReport'] as const) {
      expect(authorizeOperation(op, as('OFFICE'))).toEqual({ ok: true, ownerCheckRequired: false });
      expect(authorizeOperation(op, as('FIELD'))).toEqual({ ok: true, ownerCheckRequired: true });
    }
  });

  it('FIELD/OFFICEは作業・運搬の新規作成が可、ADMINは不可（設計書の列挙どおり）', () => {
    for (const op of ['createWorkReport', 'createDeliveryReport'] as const) {
      expect(authorizeOperation(op, as('FIELD')).ok).toBe(true);
      expect(authorizeOperation(op, as('OFFICE')).ok).toBe(true);
      expect(authorizeOperation(op, as('ADMIN'))).toEqual({ ok: false, errorCode: 'FORBIDDEN' });
    }
  });

  it('複数ロール保持時はいずれかが許可されれば可', () => {
    expect(authorizeOperation('createMaster', as('OFFICE', 'ADMIN')).ok).toBe(true);
  });

  it('冪等性 yes は設計書の7操作＋CHG-011 の調整登録・取消', () => {
    expect(ALL.filter((op) => OPERATION_POLICIES[op].idempotent).sort()).toEqual(
      ['cancelBillingAdjustment', 'confirmDeliveryReport', 'confirmWorkReport', 'createBillingAdjustment', 'createBillingRun', 'documentAction', 'transitionBillingRun', 'transitionInvoice', 'transitionRecord'],
    );
  });
});
