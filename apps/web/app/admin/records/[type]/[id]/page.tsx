import { notFound } from 'next/navigation';
import { RecordDetail } from '../../../../../components/admin/RecordDetail';

export const metadata = { title: '報告の詳細 | INSPEXOR' };

const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export default function RecordDetailPage({ params }: { params: { type: string; id: string } }) {
  if ((params.type !== 'work' && params.type !== 'delivery') || !UUID_RE.test(params.id)) notFound();
  return <RecordDetail type={params.type === 'work' ? 'WORK' : 'DELIVERY'} id={params.id.toLowerCase()} />;
}
