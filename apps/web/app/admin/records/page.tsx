import { Suspense } from 'react';
import { RecordsScreen } from '../../../components/admin/RecordsScreen';

export const metadata = { title: '報告一覧 | INSPEXOR' };

export default function RecordsPage() {
  return (
    <Suspense fallback={<p className="ix-muted">読み込み中…</p>}>
      <RecordsScreen />
    </Suspense>
  );
}
