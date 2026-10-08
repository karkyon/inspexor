import type { ReactNode } from 'react';
import { FieldShell } from '../../components/field/FieldShell';
import './field.css';

export const metadata = { title: 'INSPEXOR 現場入力' };

export default function FieldLayout({ children }: { readonly children: ReactNode }) {
  return <FieldShell>{children}</FieldShell>;
}
