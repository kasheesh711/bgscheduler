/** Browser-local recovery is best effort, never a guarantee after an OS/browser process termination. */
export type RecoveryKind = "recording" | "debrief" | "worksheet";
export type RecoveryRecord = {
  key: string;
  ownerEmail: string;
  captureId: string;
  assetId: string;
  kind: RecoveryKind;
  name: string;
  mime: string;
  createdAt: number;
  expiresAt: number;
  size: number;
  complete: boolean;
};

export interface RecoveryBackend {
  list: () => Promise<RecoveryRecord[]>;
  get: (key: string) => Promise<RecoveryRecord | null>;
  create: (record: RecoveryRecord) => Promise<void>;
  append: (key: string, blob: Blob) => Promise<void>;
  finish: (key: string) => Promise<void>;
  chunks: (key: string) => Promise<Blob[]>;
  remove: (key: string) => Promise<void>;
}

const LOCAL_TTL = 24 * 60 * 60 * 1_000;
const LIMITS: Record<RecoveryKind, number> = { recording: 100 * 1024 * 1024, debrief: 10 * 1024 * 1024, worksheet: 8 * 1024 * 1024 };

function owner(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) throw new Error("A signed-in owner is required for local recovery.");
  return normalized;
}

function keyFor(email: string, assetId: string): string { return JSON.stringify([owner(email), assetId]); }

export class LocalRecovery {
  // Serialize writes in this page so an append cannot race a finish or deletion.
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly backend: RecoveryBackend = indexedDbBackend(), private readonly now = () => Date.now()) {}

  private write<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.writes.then(action);
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  async create(email: string, input: Pick<RecoveryRecord, "captureId" | "assetId" | "kind" | "name" | "mime">): Promise<void> {
    const ownerEmail = owner(email);
    return this.write(async () => {
      const key = keyFor(ownerEmail, input.assetId);
      if (await this.backend.get(key)) return;
      const createdAt = this.now();
      await this.backend.create({ ...input, key, ownerEmail, createdAt, expiresAt: createdAt + LOCAL_TTL, size: 0, complete: false });
    });
  }

  async append(email: string, assetId: string, blob: Blob): Promise<void> {
    const key = keyFor(email, assetId);
    return this.write(async () => {
      const record = await this.backend.get(key);
      if (!record || record.expiresAt <= this.now()) throw new Error("The local recovery copy has expired.");
      if (record.complete) throw new Error("This local recording is already complete.");
      if (record.size + blob.size > LIMITS[record.kind]) throw new Error("Local recording size limit reached.");
      await this.backend.append(key, blob);
    });
  }

  async finish(email: string, assetId: string): Promise<void> {
    const key = keyFor(email, assetId);
    return this.write(async () => { if (await this.backend.get(key)) await this.backend.finish(key); });
  }

  async list(email: string): Promise<RecoveryRecord[]> {
    const ownerEmail = owner(email);
    await this.writes;
    const records = await this.backend.list();
    const stale = records.filter((record) => record.ownerEmail !== ownerEmail || record.expiresAt <= this.now());
    // Shared browsers do not retain another signed-in account's local student media.
    await Promise.all(stale.map((record) => this.backend.remove(record.key)));
    return records.filter((record) => record.ownerEmail === ownerEmail && record.expiresAt > this.now());
  }

  async load(email: string, assetId: string): Promise<{ record: RecoveryRecord; blob: Blob } | null> {
    await this.writes;
    const key = keyFor(email, assetId);
    const record = await this.backend.get(key);
    if (!record) return null;
    if (record.expiresAt <= this.now()) { await this.backend.remove(key); return null; }
    return { record, blob: new Blob(await this.backend.chunks(key), { type: record.mime }) };
  }

  async remove(email: string, assetId: string): Promise<void> {
    const key = keyFor(email, assetId);
    return this.write(() => this.backend.remove(key));
  }

  async deleteCapture(email: string, captureId: string): Promise<void> {
    const records = await this.list(email);
    await Promise.all(records.filter((record) => record.captureId === captureId).map((record) => this.remove(email, record.assetId)));
  }
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(new Error("Local recovery storage is unavailable."));
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(new Error("Local recovery could not be saved. Keep this page open or download the audio."));
  });
}

type StoredChunk = { key: string; recordKey: string; sequence: number; blob: Blob };
type StoredRecord = RecoveryRecord & { nextChunk?: number };

/** Chunks are stored separately: writing a long class does not repeatedly rewrite a 100 MB Blob. */
export function indexedDbBackend(): RecoveryBackend {
  let opening: Promise<IDBDatabase> | null = null;
  function database(): Promise<IDBDatabase> {
    if (!opening) opening = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new Error("This browser cannot keep a recovery copy.")); return; }
      const result = indexedDB.open("begifted-class-capture", 1);
      result.onupgradeneeded = () => {
        result.result.createObjectStore("records", { keyPath: "key" });
        result.result.createObjectStore("chunks", { keyPath: "key" }).createIndex("recordKey", "recordKey");
      };
      result.onsuccess = () => resolve(result.result);
      result.onerror = result.onblocked = () => reject(new Error("This browser cannot keep a recovery copy."));
    });
    return opening;
  }

  async function transaction<T>(mode: IDBTransactionMode, action: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const tx = (await database()).transaction(["records", "chunks"], mode);
    const done = completed(tx);
    try {
      const result = await action(tx);
      await done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* A failed transaction is already closed. */ }
      await done.catch(() => undefined);
      throw error;
    }
  }

  return {
    list: () => transaction("readonly", (tx) => request(tx.objectStore("records").getAll())),
    get: (key) => transaction("readonly", async (tx) => (await request(tx.objectStore("records").get(key))) ?? null),
    create: (record) => transaction("readwrite", async (tx) => { await request(tx.objectStore("records").add(record)); }),
    append: (key, blob) => transaction("readwrite", async (tx) => {
      const store = tx.objectStore("records");
      const record: StoredRecord = await request(store.get(key));
      if (!record) throw new Error("Local recovery copy no longer exists.");
      if (record.size + blob.size > LIMITS[record.kind]) throw new Error("Local recording size limit reached.");
      const sequence = record.nextChunk ?? 0;
      await request(tx.objectStore("chunks").add({ key: JSON.stringify([key, sequence]), recordKey: key, sequence, blob }));
      await request(store.put({ ...record, size: record.size + blob.size, mime: blob.type || record.mime, nextChunk: sequence + 1 }));
    }),
    finish: (key) => transaction("readwrite", async (tx) => {
      const store = tx.objectStore("records");
      const record = await request(store.get(key));
      if (record) await request(store.put({ ...record, complete: true }));
    }),
    chunks: (key) => transaction("readonly", async (tx) => {
      const chunks: StoredChunk[] = await request(tx.objectStore("chunks").index("recordKey").getAll(key));
      return chunks.sort((a, b) => a.sequence - b.sequence).map((chunk) => chunk.blob);
    }),
    remove: (key) => transaction("readwrite", async (tx) => {
      const store = tx.objectStore("chunks");
      const keys = await request(store.index("recordKey").getAllKeys(key));
      await Promise.all(keys.map((chunkKey) => request(store.delete(chunkKey))));
      await request(tx.objectStore("records").delete(key));
    }),
  };
}
