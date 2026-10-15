import { InvoiceScreen } from '../../../../components/admin/InvoiceScreen';

export const metadata = { title: '請求書 | INSPEXOR' };

// CHG-011 SCR-15（BILLING_ENABLED のときだけ。無効なら API が 404 を返す）
export default function InvoicePage({ params }: { params: { id: string } }) {
  return <InvoiceScreen id={params.id} />;
}
