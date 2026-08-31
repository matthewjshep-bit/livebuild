/**
 * A localStorage for a test that runs in node.
 *
 * `property-store` is a client module: it reads `window.localStorage` and
 * returns early when there is no window. Imported for its side effect and
 * before it, because static imports are evaluated in order - which is also why
 * this is a module rather than a few lines at the top of the test.
 */
class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

export const storage = new MemoryStorage();

(globalThis as unknown as { window: unknown }).window = { localStorage: storage };
(globalThis as unknown as { localStorage: unknown }).localStorage = storage;
