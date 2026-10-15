import type { Env } from "./types";
import { getSettings } from "./settings";
import { createStorageProvider, type StorageProvider } from "./storage";

/** Remove one directory entry; keep its storage object while another entry uses it. */
export async function deleteFileRecord(env: Env, id: string, provider?: StorageProvider): Promise<boolean> {
  const file = await env.db.prepare("SELECT key FROM files WHERE id = ?1")
    .bind(id).first<{ key: string }>();
  if (!file) return false;
  await env.db.batch([
    env.db.prepare("DELETE FROM shares WHERE file_id = ?1").bind(id),
    env.db.prepare("DELETE FROM direct_links WHERE file_id = ?1").bind(id),
    env.db.prepare("DELETE FROM download_logs WHERE file_id = ?1").bind(id),
    env.db.prepare("DELETE FROM files WHERE id = ?1").bind(id),
  ]);
  const remaining = await env.db.prepare("SELECT 1 FROM files WHERE key = ?1 LIMIT 1")
    .bind(file.key).first();
  if (!remaining) {
    const st = provider ?? await createStorageProvider(env, await getSettings(env));
    await st.delete(file.key);
  }
  return true;
}
