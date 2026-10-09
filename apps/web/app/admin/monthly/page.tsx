import { Suspense } from 'react';
import { MonthlyScreen } from '../../../components/admin/MonthlyScreen';

export const metadata = { title: '月次集計 | INSPEXOR' };

export default function MonthlyPage() {
  return (
    <Suspense fallback={<p className="ix-muted">読み込み中…</p>}>
      <MonthlyScreen />
    </Suspense>
  );
}
