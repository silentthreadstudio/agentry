// open — the memory service over a pair of roots, wired and loaded: the one composition of the store's
// layers (the Markdown files, the derived index, the service), for the CLI verbs and `lane exec close`.
//
// openMemory(roots) -> MemoryService
import { MemoryService } from "./application/memory-service.mjs";
import { SqliteTextIndex } from "./persistence/db-index.mjs";
import { MarkdownFileStore } from "./persistence/file-store.mjs";

export function openMemory(roots) {
  const service = new MemoryService(new MarkdownFileStore(roots), new SqliteTextIndex(), roots);
  service.load();
  return service;
}
