/*
 * Where listing photos, videos, plans and documents are kept. PALTAS stores only their metadata (name, type, size,
 * SHA-256); the bytes go to a storage provider through this adapter. No provider is connected yet: the test adapter
 * gives every file a key, no upload URL and no public URL, and says so.
 */
export interface MediaFile {
  orgId: string;
  listingId: string;
  mediaId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

export interface MediaStorage {
  name: string;
  connected: boolean;
  status: string;
  /** Reserve a place for the file: the key it is kept under and, with a real provider, where to upload it. */
  reserve(file: MediaFile): { storageKey: string; uploadUrl: string | null };
  /** Where the public may load a file from (null until a provider serves it). */
  publicUrl(storageKey: string): string | null;
}

export const sandboxStorage: MediaStorage = {
  name: "test-storage",
  connected: false,
  status: "Not connected — test adapter",
  reserve: (f) => ({ storageKey: `test/${f.orgId}/${f.listingId}/${f.mediaId}`, uploadUrl: null }),
  publicUrl: () => null,
};
