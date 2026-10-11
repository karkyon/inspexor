import { UsersScreen } from '../../../components/admin/UsersScreen';

export const metadata = { title: '利用者管理 | INSPEXOR' };

export default function UsersPage({ searchParams }: { searchParams: { saved?: string } }) {
  return <UsersScreen notice={searchParams.saved === 'created' ? '利用者を追加しました。' : undefined} />;
}
