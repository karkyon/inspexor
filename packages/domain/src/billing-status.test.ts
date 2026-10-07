import { describe, it, expect } from 'vitest';
import { resolveBillingTransition, UNDOCUMENTED_BILLING_STATES } from './billing-status';

describe('billing-status: システム基本設計書 §状態遷移 準拠', () => {
  it('OPEN -> calculate -> CALCULATING', () => {
    const r = resolveBillingTransition('OPEN', 'calculate', { roles: ['OFFICE'] });
    expect(r).toEqual({ ok: true, to: 'CALCULATING' });
  });

  it('CALCULATING -> complete -> CALCULATED (warningなし) / NEEDS_REVIEW (warningあり)', () => {
    const withoutWarnings = resolveBillingTransition('CALCULATING', 'complete', { roles: ['SYSTEM'] }, { hasWarnings: false });
    expect(withoutWarnings).toEqual({ ok: true, to: 'CALCULATED' });
    const withWarnings = resolveBillingTransition('CALCULATING', 'complete', { roles: ['SYSTEM'] }, { hasWarnings: true });
    expect(withWarnings).toEqual({ ok: true, to: 'NEEDS_REVIEW' });
  });

  it('CALCULATING -> complete: hasWarnings未指定はVALIDATION_ERROR', () => {
    const r = resolveBillingTransition('CALCULATING', 'complete', { roles: ['SYSTEM'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('VALIDATION_ERROR');
  });

  it('NEEDS_REVIEW -> review -> REVIEWED', () => {
    const r = resolveBillingTransition('NEEDS_REVIEW', 'review', { roles: ['ADMIN'] });
    expect(r).toEqual({ ok: true, to: 'REVIEWED' });
  });

  it('CALCULATED/REVIEWED -> finalize -> FINALIZED', () => {
    expect(resolveBillingTransition('CALCULATED', 'finalize', { roles: ['OFFICE'] })).toEqual({ ok: true, to: 'FINALIZED' });
    expect(resolveBillingTransition('REVIEWED', 'finalize', { roles: ['OFFICE'] })).toEqual({ ok: true, to: 'FINALIZED' });
  });

  it('FINALIZED -> issue -> ISSUED (SYSTEMのみ)', () => {
    expect(resolveBillingTransition('FINALIZED', 'issue', { roles: ['SYSTEM'] })).toEqual({ ok: true, to: 'ISSUED' });
    const ng = resolveBillingTransition('FINALIZED', 'issue', { roles: ['ADMIN'] });
    expect(ng.ok).toBe(false);
  });

  it('ISSUED -> mailSent -> SENT (SYSTEMのみ)', () => {
    expect(resolveBillingTransition('ISSUED', 'mailSent', { roles: ['SYSTEM'] })).toEqual({ ok: true, to: 'SENT' });
  });

  it('VOIDEDは未解決状態としてマークされている', () => {
    expect(UNDOCUMENTED_BILLING_STATES).toContain('VOIDED');
  });

  it('未定義の遷移はSTATE_CONFLICT', () => {
    const r = resolveBillingTransition('VOIDED', 'calculate', { roles: ['ADMIN'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('STATE_CONFLICT');
  });
});
