cd ~/inspexor

cat > packages/application/src/command-pipeline.ts << 'EOF'
/**
 * docs/adr/0001-gap-003-command-pipeline-order.md 準拠。
 * 00契約 不変条件2の順序（00契約を機能別詳細設計書より優先）:
 * 認証 → CSRF → 認可(role/owner) → Zod → expectedVersion → state guard → 業務制約
 *
 * domain invariant検証、revision/audit/outbox挿入、version+1、commitはこのpipelineの外
 * （application service内でDB transactionとして実行する責務であり、ここには含めない）。
 */

import type { ErrorCode } from '@inspexor/domain';

export type PipelineStepName =
  | 'authentication'
  | 'csrf'
  | 'authorization'
  | 'validation'
  | 'version'
  | 'state'
  | 'businessRule';

export interface PipelineStepResult {
  readonly ok: boolean;
  readonly errorCode?: ErrorCode;
  readonly message?: string;
}

export type PipelineStep<TContext> = (ctx: TContext) => PipelineStepResult | Promise<PipelineStepResult>;

export interface PipelineDefinition<TContext> {
  readonly authentication: PipelineStep<TContext>;
  readonly csrf: PipelineStep<TContext>;
  readonly authorization: PipelineStep<TContext>;
  readonly validation: PipelineStep<TContext>;
  readonly version: PipelineStep<TContext>;
  readonly state: PipelineStep<TContext>;
  readonly businessRule: PipelineStep<TContext>;
}

// ADR-0001で確定した検査順序。この配列の並びがそのまま契約である。
const STEP_ORDER: readonly PipelineStepName[] = [
  'authentication',
  'csrf',
  'authorization',
  'validation',
  'version',
  'state',
  'businessRule',
];

export type PipelineOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failedStep: PipelineStepName;
      readonly errorCode?: ErrorCode;
      readonly message?: string;
    };

export async function runCommandPipeline<TContext>(
  definition: PipelineDefinition<TContext>,
  context: TContext,
): Promise<PipelineOutcome> {
  for (const stepName of STEP_ORDER) {
    const step = definition[stepName];
    // eslint-disable-next-line no-await-in-loop
    const result = await step(context);
    if (!result.ok) {
      // exactOptionalPropertyTypes: true のため、undefinedを明示代入せず
      // 値が存在する場合だけspreadでプロパティを追加する。
      return {
        ok: false,
        failedStep: stepName,
        ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
        ...(result.message !== undefined ? { message: result.message } : {}),
      };
    }
  }
  return { ok: true };
}

export const COMMAND_PIPELINE_STEP_ORDER = STEP_ORDER;
EOF

cat > packages/application/src/command-pipeline.test.ts << 'EOF'
import { describe, it, expect, vi } from 'vitest';
import { runCommandPipeline, COMMAND_PIPELINE_STEP_ORDER, type PipelineDefinition } from './command-pipeline';

function okStep() {
  return vi.fn().mockReturnValue({ ok: true });
}

describe('command-pipeline: ADR-0001順序準拠', () => {
  it('ステップ順序はADR-0001どおり', () => {
    expect(COMMAND_PIPELINE_STEP_ORDER).toEqual([
      'authentication', 'csrf', 'authorization', 'validation', 'version', 'state', 'businessRule',
    ]);
  });

  it('全ステップPASSなら ok:true、全ステップが呼ばれる', async () => {
    const steps: PipelineDefinition<Record<string, never>> = {
      authentication: okStep(),
      csrf: okStep(),
      authorization: okStep(),
      validation: okStep(),
      version: okStep(),
      state: okStep(),
      businessRule: okStep(),
    };
    const result = await runCommandPipeline(steps, {});
    expect(result).toEqual({ ok: true });
    for (const name of COMMAND_PIPELINE_STEP_ORDER) {
      expect(steps[name]).toHaveBeenCalledTimes(1);
    }
  });

  it('認可(authorization)失敗時はvalidation以降が呼ばれない（short-circuit）', async () => {
    const authorization = vi.fn().mockReturnValue({ ok: false, errorCode: 'FORBIDDEN', message: '権限なし' });
    const validation = okStep();
    const steps: PipelineDefinition<Record<string, never>> = {
      authentication: okStep(),
      csrf: okStep(),
      authorization,
      validation,
      version: okStep(),
      state: okStep(),
      businessRule: okStep(),
    };
    const result = await runCommandPipeline(steps, {});
    expect(result).toEqual({ ok: false, failedStep: 'authorization', errorCode: 'FORBIDDEN', message: '権限なし' });
    expect(validation).not.toHaveBeenCalled();
  });

  it('errorCode/messageを返さないステップ失敗時はそのキーを含まない', async () => {
    const authorization = vi.fn().mockReturnValue({ ok: false });
    const steps: PipelineDefinition<Record<string, never>> = {
      authentication: okStep(),
      csrf: okStep(),
      authorization,
      validation: okStep(),
      version: okStep(),
      state: okStep(),
      businessRule: okStep(),
    };
    const result = await runCommandPipeline(steps, {});
    expect(result).toEqual({ ok: false, failedStep: 'authorization' });
    if (!result.ok) {
      expect('errorCode' in result).toBe(false);
      expect('message' in result).toBe(false);
    }
  });

  it('認証(authentication)はCSRFより先に検査される', async () => {
    const callOrder: string[] = [];
    const makeStep = (name: string) => vi.fn().mockImplementation(() => {
      callOrder.push(name);
      return { ok: true };
    });
    const steps: PipelineDefinition<Record<string, never>> = {
      authentication: makeStep('authentication'),
      csrf: makeStep('csrf'),
      authorization: makeStep('authorization'),
      validation: makeStep('validation'),
      version: makeStep('version'),
      state: makeStep('state'),
      businessRule: makeStep('businessRule'),
    };
    await runCommandPipeline(steps, {});
    expect(callOrder).toEqual([
      'authentication', 'csrf', 'authorization', 'validation', 'version', 'state', 'businessRule',
    ]);
  });
});
EOF

echo "=== application: tsc --noEmit ==="
(cd packages/application && npx tsc --noEmit) && echo "TSC: PASS"

echo "=== application: vitest run ==="
(cd packages/application && npx vitest run)

echo "=== domain: tsc --noEmit (再確認) ==="
(cd packages/domain && npx tsc --noEmit) && echo "TSC: PASS"

echo "=== domain: vitest run (再確認) ==="
(cd packages/domain && npx vitest run)
