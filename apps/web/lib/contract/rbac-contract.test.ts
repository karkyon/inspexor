/**
 * G1-CONTRACT: RBAC方針表（packages/domain/src/rbac.ts）と openapi.yaml の照合。
 *  - openapi の全 operationId に方針がある / 方針の method+path が openapi に存在する（双方向）
 *  - 冪等性: Idempotency-Key parameter の有無と policy.idempotent が一致（既知GAPのみ例外）
 *  - security: [] の operation は PUBLIC のみ
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { OPERATION_POLICIES, KNOWN_IDEMPOTENCY_GAPS, type OperationId } from '@inspexor/domain';
import { findSpecFile } from '../testing/fresh-db';

type Op = { operationId: string; parameters?: Array<{ $ref?: string; name?: string }>; security?: unknown[] };
type Doc = { paths: Record<string, Record<string, Op | unknown>> };

const doc = parse(readFileSync(findSpecFile('openapi.yaml', 'OPENAPI_PATH'), 'utf8')) as Doc;
const METHODS = ['get', 'post', 'patch', 'delete', 'put'] as const;

const operations: Array<{ path: string; method: string; op: Op }> = [];
for (const [path, item] of Object.entries(doc.paths)) {
  for (const method of METHODS) {
    const op = item[method] as Op | undefined;
    if (op !== undefined) operations.push({ path, method: method.toUpperCase(), op });
  }
}

const hasIdempotencyKey = (op: Op) =>
  (op.parameters ?? []).some((p) => p.$ref === '#/components/parameters/IdempotencyKey' || p.name === 'Idempotency-Key');

describe('G1-CONTRACT: RBAC ⇔ openapi', () => {
  it('openapi 28 operation（25＋CHG-004 の3件）すべてに RBAC 方針がある', () => {
    expect(operations).toHaveLength(28);
    for (const { op } of operations) {
      expect(Object.keys(OPERATION_POLICIES), `方針なし: ${op.operationId}`).toContain(op.operationId);
    }
  });

  it.each(Object.keys(OPERATION_POLICIES) as OperationId[])('%s の method/path が openapi と一致', (id) => {
    const policy = OPERATION_POLICIES[id];
    const found = operations.find((o) => o.op.operationId === id);
    expect(found, `openapiに無い: ${id}`).toBeDefined();
    expect(found?.method).toBe(policy.method);
    expect(found?.path).toBe(policy.path);
  });

  it.each(Object.keys(OPERATION_POLICIES) as OperationId[])('%s の冪等性が openapi と一致（既知GAP除く）', (id) => {
    const found = operations.find((o) => o.op.operationId === id);
    if (found === undefined) throw new Error(id);
    if (KNOWN_IDEMPOTENCY_GAPS.includes(id)) {
      // GAP-011: 設計書=yes / openapi=Idempotency-Key無し。差分が残っていることを明示的に固定する
      expect(OPERATION_POLICIES[id].idempotent).toBe(true);
      expect(hasIdempotencyKey(found.op)).toBe(false);
      return;
    }
    expect(OPERATION_POLICIES[id].idempotent).toBe(hasIdempotencyKey(found.op));
  });

  it('openapi で security: [] の operation は PUBLIC のみ', () => {
    for (const { op } of operations) {
      const isPublicInSpec = Array.isArray(op.security) && op.security.length === 0;
      const policy = OPERATION_POLICIES[op.operationId as OperationId];
      expect(policy.access.kind === 'PUBLIC', op.operationId).toBe(isPublicInSpec);
    }
  });
});
