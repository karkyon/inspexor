import { UserCreateScreen, UserDetailScreen } from '../../../../components/admin/UsersScreen';

export const metadata = { title: '利用者 | INSPEXOR' };

export default function UserPage({ params }: { params: { id: string } }) {
  return params.id === 'new' ? <UserCreateScreen /> : <UserDetailScreen id={params.id} />;
}
