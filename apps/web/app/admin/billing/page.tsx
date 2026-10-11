import { BillingListScreen } from '../../../components/admin/BillingScreen';

export const metadata = { title: '請求 | INSPEXOR' };

// CHG-009 SCR-14（BILLING_ENABLED のときだけ。無効なら API が 404 を返し、メニューにも出さない）
export default function BillingPage() {
  return <BillingListScreen />;
}
