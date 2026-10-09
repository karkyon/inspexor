'use client';

/** 事務所画面の名称解決（listMasters 全ページ）。種別ごとに id → { code, name, ... } */
import { useEffect, useState } from 'react';
import { apiRequest } from '../../lib/api/client';

export interface NamedRow {
  readonly id: string;
  readonly code?: string;
  readonly name?: string;
  readonly active: boolean;
  readonly customerId?: string;
  readonly productId?: string;
  readonly sortOrder?: number;
}

export type NameMaps = Readonly<Record<string, ReadonlyMap<string, NamedRow>>>;

async function loadAll(type: string): Promise<Map<string, NamedRow>> {
  const map = new Map<string, NamedRow>();
  for (let page = 1; page <= 50; page += 1) {
    const res = await apiRequest<NamedRow[]>('GET', `/masters/${type}?page=${page}&pageSize=100`);
    if (!res.ok) break;
    for (const row of res.data) map.set(row.id, row);
    if (page * 100 >= (res.meta?.total ?? 0)) break;
  }
  return map;
}

export function useMasterNames(types: readonly string[]): NameMaps | null {
  const [maps, setMaps] = useState<NameMaps | null>(null);
  const key = types.join(',');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(key.split(',').map(async (t) => [t, await loadAll(t)] as const));
      if (!cancelled) setMaps(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);
  return maps;
}

export function label(maps: NameMaps | null, type: string, id: string | null | undefined): string {
  if (id === null || id === undefined || id === '') return '—';
  const r = maps?.[type]?.get(id);
  if (r === undefined) return maps === null ? '…' : '（不明）';
  return `${r.code ?? ''} ${r.name ?? ''}`.trim();
}
