import { AccountScreen } from '../../../components/admin/AccountScreen';

export const metadata = { title: '多要素認証 | INSPEXOR' };

// CHG-012（ADMIN_MFA_ENABLED のとき、管理者のメニューに出す）
export default function AccountPage() {
  return <AccountScreen />;
}
