import { Suspense } from 'react';
import { DeliveryWizard } from '../../../../components/field/DeliveryWizard';

/** SCR-03〜05 運搬 Step1〜3（?step=1..3） */
export default function DeliveryNewPage() {
  return (
    <Suspense fallback={<p aria-busy="true">読み込み中…</p>}>
      <DeliveryWizard />
    </Suspense>
  );
}
