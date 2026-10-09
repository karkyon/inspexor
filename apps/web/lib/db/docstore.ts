import { FirestoreDocStore, type DocStore } from '@inspexor/docstore';

/**
 * CHG-006: アプリの DocStore（Cloud Firestore）。
 *   FIRESTORE_PROJECT_ID   必須（Cloud Run・Cloud Shell とも明示する。誤ったプロジェクトへの書込を防ぐ）
 *   FIRESTORE_DATABASE_ID  任意（既定 '(default)'）
 *   FIRESTORE_EMULATOR_HOST があれば SDK がエミュレータへ接続する
 */
const globalForStore = globalThis as unknown as { inspexorDocStore?: DocStore | undefined };

export function getDocStore(): DocStore {
  if (globalForStore.inspexorDocStore === undefined) {
    const projectId = process.env['FIRESTORE_PROJECT_ID'];
    if (!projectId) throw new Error('FIRESTORE_PROJECT_ID is not set');
    const databaseId = process.env['FIRESTORE_DATABASE_ID'];
    globalForStore.inspexorDocStore = new FirestoreDocStore({ projectId, ...(databaseId ? { databaseId } : {}) });
  }
  return globalForStore.inspexorDocStore;
}

/** 試験用: 差し替え */
export function setDocStoreForTest(store: DocStore | undefined): void {
  globalForStore.inspexorDocStore = store;
}
