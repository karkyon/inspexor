/** CHG-008: アプリ（本番・開発）で使う利用者の有効確認（Firestore の users）。CHG-012: 管理者の多要素認証（ADMIN_MFA_ENABLED） */
import { featureFlags } from '@inspexor/domain';
import { getDocStore } from '../db/docstore';
import { createUserGuard } from './user-guard';

export const appUserGuard = createUserGuard(() => getDocStore(), () => Date.now(), { adminMfaEnabled: () => featureFlags(process.env).adminMfa });
