'use client';

/** SCR-01 ログイン（v6.0: ブランド説明と認証カードを分離）。/login と、未ログインで開いたホーム（/）の両方で使う。 */
import { LoginForm } from './LoginForm';
import type { LoginSuccessData } from '../lib/auth/login-response';

export function LoginScreen({ onLoginSuccess }: { readonly onLoginSuccess: (data: LoginSuccessData) => void }) {
  return (
    <div className="px-page">
      <main className="px-loginwrap">
        <div className="px-login">
          <section className="px-loginbrand" aria-label="INSPEXOR について">
            <div className="px-logo" aria-hidden="true">IX</div>
            <h1>
              現場の実績を、
              <br />
              そのまま日報に。
            </h1>
            <p>作業日報・運搬実績をタブレットで入力し、作業結果報告書を自動で作成します。</p>
            <ul className="px-promise">
              <li>5分刻みのかんたん入力</li>
              <li>作業結果報告書を PDF で自動作成</li>
              <li>月次集計を Excel・CSV で出力</li>
            </ul>
          </section>
          <section className="px-loginbox" aria-labelledby="login-title">
            <div>
              <small>INSPEXOR</small>
              <h2 id="login-title">ログイン</h2>
              <p className="px-lead">ログインしてください。会社から発行されたログインIDとパスワードを入力します。</p>
            </div>
            <LoginForm onLoginSuccess={onLoginSuccess} />
            <p className="px-secure">🔒 通信は暗号化されています</p>
          </section>
        </div>
      </main>
    </div>
  );
}
