'use client';

import { useRouter } from 'next/navigation';
import { LoginForm } from './LoginForm';

export function LoginPageClient() {
  const router = useRouter();

  return (
    <div>
      <h1>INSPEXOR ログイン</h1>
      <LoginForm
        onLoginSuccess={() => {
          router.push('/');
        }}
      />
    </div>
  );
}
