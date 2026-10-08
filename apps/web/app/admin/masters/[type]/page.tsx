import { notFound } from 'next/navigation';
import { MasterScreen } from '../../../../components/admin/MasterScreen';
import { isMasterType } from '../../../../lib/masters/definitions';

const SAVED_NOTICE: Readonly<Record<string, string>> = {
  created: '登録しました。',
  updated: '保存しました。',
  deactivated: '無効化しました。',
};

export default function MasterListPage({
  params,
  searchParams,
}: {
  readonly params: { readonly type: string };
  readonly searchParams: { readonly saved?: string | string[] };
}) {
  if (!isMasterType(params.type)) notFound();
  const saved = typeof searchParams.saved === 'string' ? SAVED_NOTICE[searchParams.saved] : undefined;
  return <MasterScreen key={params.type} type={params.type} notice={saved} />;
}
