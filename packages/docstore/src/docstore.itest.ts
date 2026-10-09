import { docStoreContract } from './contract';
import { createTestStore } from './testing';

// Firestore エミュレータ（FIRESTORE_EMULATOR_HOST）で memory と同じ契約を満たすこと
docStoreContract(process.env['FIRESTORE_EMULATOR_HOST'] ? 'Firestore エミュレータ' : 'memory（エミュレータ未設定）', () => {
  const t = createTestStore('contract');
  return { store: t.store, kind: t.kind };
});
