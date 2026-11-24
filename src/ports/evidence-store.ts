/** Private storage for evidence files. Keys are built only from server-generated IDs. */
export interface StoredEvidence {
  sha256: string;
  byteSize: number;
}

export interface EvidenceStore {
  put(key: string, bytes: Uint8Array): Promise<StoredEvidence>;
  get(key: string): Promise<Uint8Array>;
  /** Delete an evidence object and any incomplete write left for that key. Missing objects are already erased. */
  remove(key: string): Promise<void>;
}
