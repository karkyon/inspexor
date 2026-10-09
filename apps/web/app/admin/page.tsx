import { redirect } from 'next/navigation';

/** CHG-004: 事務所画面の入口は報告一覧（提案書 P.6） */
export default function AdminIndexPage() {
  redirect('/admin/records');
}
