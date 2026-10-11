import { BillingRunScreen } from '../../../../components/admin/BillingScreen';

export const metadata = { title: '請求計算・レビュー | INSPEXOR' };

export default function BillingRunPage({ params, searchParams }: { params: { id: string }; searchParams: { notice?: string } }) {
  return <BillingRunScreen id={params.id} notice={searchParams.notice === 'exists' ? 'exists' : undefined} />;
}
