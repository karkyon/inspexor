import { redirect } from 'next/navigation';

/** SCR-13 の既定表示は品番（ワイヤーフレーム v6.0） */
export default function MastersIndexPage() {
  redirect('/admin/masters/products');
}
