'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../../lib/api/client';
import type { LookupEntry, Lookups } from '../../lib/masters/ui';

const EMPTY: Lookups = { customers: new Map(), products: new Map(), 'work-types': new Map() };

async function loadAll(type: keyof Lookups): Promise<Map<string, LookupEntry>> {
  const map = new Map<string, LookupEntry>();
  for (let page = 1; page <= 50; page += 1) {
    const res = await apiRequest<LookupEntry[]>('GET', `/masters/${type}?page=${page}&pageSize=100`);
    if (!res.ok) break;
    for (const row of res.data) map.set(row.id, row);
    const total = res.meta?.total ?? 0;
    if (page * 100 >= total) break;
  }
  return map;
}

/** 参照先（顧客・品番・作業内容）の名称解決用。表示・選択肢に使う */
export function useLookups(): { lookups: Lookups; reload: () => void } {
  const [lookups, setLookups] = useState<Lookups>(EMPTY);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [customers, products, workTypes] = await Promise.all([loadAll('customers'), loadAll('products'), loadAll('work-types')]);
      if (!cancelled) setLookups({ customers, products, 'work-types': workTypes });
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { lookups, reload };
}
