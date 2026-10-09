/**
 * 試験用の DocStore を作る。
 *  - FIRESTORE_EMULATOR_HOST があれば Firestore エミュレータ（試験ごとに別の projectId で分離）
 *  - 無ければ MemoryDocStore（firestore.indexes.json の索引を検査）
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FirestoreDocStore } from './firestore';
import { MemoryDocStore } from './memory';
import type { IndexDefinition } from './query';
import type { DocStore } from './types';

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('pnpm-workspace.yaml が見つかりません');
    dir = parent;
  }
}

export function loadIndexDefinitions(path?: string): IndexDefinition[] {
  const file = path ?? join(findRepoRoot(process.cwd()), 'infra', 'firestore', 'firestore.indexes.json');
  const json = JSON.parse(readFileSync(file, 'utf8')) as { indexes?: IndexDefinition[] };
  return json.indexes ?? [];
}

export interface TestStore {
  readonly store: DocStore;
  readonly kind: 'emulator' | 'memory';
  close(): Promise<void>;
}

export function createTestStore(label: string): TestStore {
  if (process.env['FIRESTORE_EMULATOR_HOST']) {
    const projectId = `itest-${label}-${randomUUID().slice(0, 8)}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);
    const store = new FirestoreDocStore({ projectId });
    return { store, kind: 'emulator', close: () => store.close() };
  }
  const store = new MemoryDocStore({ indexes: loadIndexDefinitions() });
  return { store, kind: 'memory', close: () => store.close() };
}
