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
