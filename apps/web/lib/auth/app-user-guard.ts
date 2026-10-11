/** CHG-008: アプリ（本番・開発）で使う利用者の有効確認（Firestore の users） */
import { getDocStore } from '../db/docstore';
import { createUserGuard } from './user-guard';

export const appUserGuard = createUserGuard(() => getDocStore());
