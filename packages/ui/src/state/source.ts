import { effect, signal } from "@preact/signals";
import { api } from "../api/client";
import type { SourceResponse } from "../api/types";

export interface SourceRequest {
  file: string;
  line: number;
}

export const openSource = signal<SourceRequest | null>(null);
export const sourceData = signal<SourceResponse | null>(null);
export const sourceError = signal<string | null>(null);
export const sourceLoading = signal(false);

/** Fetch whenever openSource changes. Null closes the viewer. */
effect(() => {
  const req = openSource.value;
  if (!req) {
    sourceData.value = null;
    sourceError.value = null;
    sourceLoading.value = false;
    return;
  }
  sourceLoading.value = true;
  sourceError.value = null;
  api
    .source(req.file, req.line, 15)
    .then((r) => {
      sourceData.value = r;
      sourceLoading.value = false;
    })
    .catch((err) => {
      sourceData.value = null;
      sourceError.value = (err as Error).message;
      sourceLoading.value = false;
    });
});

export function openSourceAt(file: string, line: number): void {
  openSource.value = { file, line };
}

export function closeSource(): void {
  openSource.value = null;
}
