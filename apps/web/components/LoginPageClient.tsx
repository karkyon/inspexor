'use client';

import { useRouter } from 'next/navigation';
import { LoginScreen } from './LoginScreen';

export function LoginPageClient() {
  const router = useRouter();
  return <LoginScreen onLoginSuccess={() => router.push('/')} />;
}
