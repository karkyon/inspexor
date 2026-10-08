'use client';

/**
 * 現場入力で使うマスタ（API-014 listMasters、全ページ取得）。有効行だけを選択肢にし、
 * 通信復帰時（online）に再取得して下書きの master を再検証する（REQ-OFF-001）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../../lib/api/client';
import type { MasterLookup } from '../../lib/field/wizard';

export interface MasterRow {
  readonly id: string;
  readonly active: boolean;
  readonly code?: string;
  readonly name?: string;
  readonly customerId?: string;
  readonly productId?: string;
  readonly lotRequired?: boolean;
  readonly sortOrder?: number;
  readonly holidayDate?: string;
  readonly settlementType?: string;
}

export interface FieldMasters {
  readonly customers: readonly MasterRow[];
  readonly products: readonly MasterRow[];
  readonly workTypes: readonly MasterRow[];
  readonly defects: readonly MasterRow[];
  readonly workers: readonly MasterRow[];
  readonly holidays: readonly MasterRow[];
}

const TYPES = { customers: 'customers', products: 'products', workTypes: 'work-types', defects: 'defects', workers: 'workers', holidays: 'holidays' } as const;

async function loadAll(type: string): Promise<MasterRow[] | null> {
  const rows: MasterRow[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const res = await apiRequest<MasterRow[]>('GET', `/masters/${type}?page=${page}&pageSize=100`);
    if (!res.ok) return null;
    rows.push(...res.data);
    if (page * 100 >= (res.meta?.total ?? 0)) break;
  }
  return rows;
}

const byCode = (a: MasterRow, b: MasterRow) => (a.code ?? '').localeCompare(b.code ?? '');

export function useFieldMasters(online: boolean) {
  const [masters, setMasters] = useState<FieldMasters | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const entries = await Promise.all(Object.entries(TYPES).map(async ([k, t]) => [k, await loadAll(t)] as const));
    if (entries.some(([, rows]) => rows === null)) {
      setError('マスタを取得できませんでした。通信状態を確認して再読込してください。');
      return;
    }
    setMasters(Object.fromEntries(entries.map(([k, rows]) => [k, [...(rows as MasterRow[])].sort(byCode)])) as unknown as FieldMasters);
    setLoadedAt(new Date());
    setError(null);
  }, []);

  useEffect(() => {
    if (online) void load();
  }, [online, load]);

  const lookup = useMemo<MasterLookup | null>(() => {
    if (masters === null) return null;
    const active = (rows: readonly MasterRow[]) => new Map(rows.filter((r) => r.active).map((r) => [r.id, r]));
    const customers = active(masters.customers);
    const products = active(masters.products);
    const workTypes = active(masters.workTypes);
    const workers = active(masters.workers);
    const defects = active(masters.defects);
    return {
      activeCustomer: (id) => customers.has(id),
      product: (id) => {
        const p = products.get(id);
        return p === undefined ? undefined : { customerId: p.customerId ?? '', lotRequired: p.lotRequired === true };
      },
      workType: (id) => {
        const w = workTypes.get(id);
        return w === undefined ? undefined : { productId: w.productId ?? '' };
      },
      worker: (id) => workers.has(id),
      defectType: (id) => {
        const d = defects.get(id);
        return d === undefined ? undefined : { productId: d.productId ?? '' };
      },
    };
  }, [masters]);

  return { masters, lookup, loadedAt, error, reload: load };
}

export function nameOf(rows: readonly MasterRow[] | undefined, id: string): string {
  const r = rows?.find((x) => x.id === id);
  return r === undefined ? '（不明）' : `${r.code ?? ''} ${r.name ?? ''}`.trim();
}
