import type { ReactNode } from 'react';
import { AdminShell } from '../../components/admin/AdminShell';
import './admin.css';

export const metadata = { title: 'INSPEXOR 管理' };

export default function AdminLayout({ children }: { readonly children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
