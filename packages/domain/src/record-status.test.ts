import { describe, it, expect } from 'vitest';
import { resolveRecordTransition } from './record-status';

describe('record-status: システム基本設計書 §状態遷移 準拠', () => {
  it('DRAFT -> confirm -> CONFIRMED (owner)', () => {
    const r = resolveRecordTransition('DRAFT', 'confirm', { roles: ['FIELD'], isOwner: true });
    expect(r).toEqual({ ok: true, to: 'CONFIRMED' });
  });

  it('DRAFT -> confirm -> CONFIRMED (OFFICE, not owner)', () => {
    const r = resolveRecordTransition('DRAFT', 'confirm', { roles: ['OFFICE'], isOwner: false });
    expect(r).toEqual({ ok: true, to: 'CONFIRMED' });
  });

  it('DRAFT -> confirm: FIELD非ownerは拒否', () => {
    const r = resolveRecordTransition('DRAFT', 'confirm', { roles: ['FIELD'], isOwner: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('FORBIDDEN');
  });

  it('CONFIRMED -> documentGenerated -> SUBMITTED (SYSTEMのみ)', () => {
    const ok = resolveRecordTransition('CONFIRMED', 'documentGenerated', { roles: ['SYSTEM'], isOwner: false });
    expect(ok).toEqual({ ok: true, to: 'SUBMITTED' });
    const ng = resolveRecordTransition('CONFIRMED', 'documentGenerated', { roles: ['ADMIN'], isOwner: false });
    expect(ng.ok).toBe(false);
  });

  it('SUBMITTED -> approve -> APPROVED', () => {
    const r = resolveRecordTransition('SUBMITTED', 'approve', { roles: ['OFFICE'], isOwner: false });
    expect(r).toEqual({ ok: true, to: 'APPROVED' });
  });

  it('SUBMITTED -> reject: reason必須', () => {
    const noReason = resolveRecordTransition('SUBMITTED', 'reject', { roles: ['ADMIN'], isOwner: false });
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.errorCode).toBe('VALIDATION_ERROR');
    const withReason = resolveRecordTransition('SUBMITTED', 'reject', { roles: ['ADMIN'], isOwner: false }, '不良率超過');
    expect(withReason).toEqual({ ok: true, to: 'REJECTED' });
  });

  it('APPROVED -> revoke -> REVOKED: reason必須', () => {
    const r = resolveRecordTransition('APPROVED', 'revoke', { roles: ['OFFICE'], isOwner: false }, '客先訂正依頼');
    expect(r).toEqual({ ok: true, to: 'REVOKED' });
  });

  it('REJECTED/REVOKED -> revise -> DRAFT (owner or OFFICE)', () => {
    expect(resolveRecordTransition('REJECTED', 'revise', { roles: ['FIELD'], isOwner: true })).toEqual({ ok: true, to: 'DRAFT' });
    expect(resolveRecordTransition('REVOKED', 'revise', { roles: ['OFFICE'], isOwner: false })).toEqual({ ok: true, to: 'DRAFT' });
  });

  it('APPROVED -> billingFinalize -> BILLING_LOCKED (SYSTEMのみ)', () => {
    const r = resolveRecordTransition('APPROVED', 'billingFinalize', { roles: ['SYSTEM'], isOwner: false });
    expect(r).toEqual({ ok: true, to: 'BILLING_LOCKED' });
  });

  it('未定義の遷移はSTATE_CONFLICT', () => {
    const r = resolveRecordTransition('BILLING_LOCKED', 'confirm', { roles: ['ADMIN'], isOwner: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('STATE_CONFLICT');
  });
});
