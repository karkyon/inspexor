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
