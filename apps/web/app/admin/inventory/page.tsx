import { Suspense } from 'react';
import { InventoryScreen } from '../../../components/admin/InventoryScreen';

export const metadata = { title: '在庫 | INSPEXOR' };

export default function InventoryPage() {
  return (
    <Suspense fallback={<p className="ix-muted">読み込み中…</p>}>
      <InventoryScreen />
    </Suspense>
  );
}
