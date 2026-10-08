import { Suspense } from 'react';
import { WorkWizard } from '../../../../components/field/WorkWizard';

/** SCR-06〜09 作業 Step1〜5（?step=1..5。SCR-09 = Step4/5） */
export default function WorkNewPage() {
  return (
    <Suspense fallback={<p aria-busy="true">読み込み中…</p>}>
      <WorkWizard />
    </Suspense>
  );
}
