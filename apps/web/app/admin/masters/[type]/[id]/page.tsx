import { notFound } from 'next/navigation';
import { MasterEditor } from '../../../../../components/admin/MasterEditor';
import { isMasterType } from '../../../../../lib/masters/definitions';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** id = 'new' は新規登録、UUID は編集（参照） */
export default function MasterEditPage({ params }: { readonly params: { readonly type: string; readonly id: string } }) {
  if (!isMasterType(params.type)) notFound();
  if (params.id !== 'new' && !UUID_RE.test(params.id)) notFound();
  return <MasterEditor key={`${params.type}/${params.id}`} type={params.type} id={params.id} />;
}
