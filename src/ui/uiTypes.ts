import type { StoreResult } from '../store/Store.ts';

export type Action = <T>(work: () => Promise<StoreResult<T>>, success?: (value: T) => void) => Promise<void>;
export function downloadText(filename: string, content: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
