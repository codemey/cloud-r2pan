import type { Env, FileRow } from "./types";
import { randomId } from "./db";
import { clientIp, isAdminWhitelisted } from "./auth";
import { encryptSecret, decryptSecret } from "./crypto";
import { getSettings } from "./settings";
import { verifyOAuthSession } from "./oauth";
import { json } from "./pages";
import { createStorageProvider } from "./storage";
import {
  hashPassword, verifyPassword, issueToken, verifyShareToken, streamFile,
  isTurnstileEnabled, getTurnstileInfo, verifyTurnstileToken,
} from "./public";

interface FolderShare {
  id: string;
  path: string;
  created_at: number;
  expires_at: number | null;
  max_downloads: number | null;
  download_count: number;
  revoked: number;
  password_hash: string | null;
  password_cipher: string | null;
  note: string | null;
}

export function validPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value === "/" || value.endsWith("/") || value.includes("\\")) return null;
  const parts = value.slice(1).split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\u0000-\u001f\u007f]/.test(part))) return null;
  return value;
}

function bounds(path: string): [string, string] {
  const prefix = path + "/";
  return [prefix, path + "0"];
}

export async function folderExists(env: Env, path: string): Promise<boolean> {
  if (await env.db.prepare("SELECT 1 FROM directories WHERE path = ?1").bind(path).first()) return true;
  const [lower, upper] = bounds(path);
  const [file, directory] = await Promise.all([
    env.db.prepare("SELECT 1 FROM files WHERE path >= ?1 AND path < ?2 LIMIT 1").bind(lower, upper).first(),
    env.db.prepare("SELECT 1 FROM directories WHERE path >= ?1 AND path < ?2 LIMIT 1").bind(lower, upper).first(),
  ]);
  return !!file || !!directory;
}

async function rowsInFolder<T>(env: Env, table: "files" | "directories", path: string): Promise<T[]> {
  const [lower, upper] = bounds(path);
  const rows: T[] = [];
  for (let offset = 0; ; offset += 500) {
    const result = await env.db.prepare(
      `SELECT ${table === "files" ? "id, key, name, size, mime, path, uploaded_at" : "path"} FROM ${table}
       WHERE path >= ?1 AND path < ?2 ORDER BY path LIMIT 500 OFFSET ?3`
    ).bind(lower, upper, offset).all<T>();
    rows.push(...result.results);
    if (result.results.length < 500) break;
  }
  return rows;
}

function folderStatus(row: FolderShare): "ok" | "gone" | "expired" | "maxed" {
  if (row.revoked) return "gone";
  if (row.expires_at && row.expires_at <= Date.now()) return "expired";
  if (row.max_downloads && row.download_count >= row.max_downloads) return "maxed";
  return "ok";
}

async function getFolderShare(env: Env, token: string): Promise<FolderShare | null> {
  return env.db.prepare("SELECT * FROM folder_shares WHERE id = ?1").bind(token).first<FolderShare>();
}

function folderTicket(token: string): string { return `folder:${token}`; }

export async function handleFolderAdmin(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path === "/api/admin/folders" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { path?: unknown };
    const folderPath = validPath(body.path);
    if (!folderPath) return json({ error: "Invalid folder path" }, { status: 400 });
    const parent = folderPath.slice(0, folderPath.lastIndexOf("/")) || "/";
    if (parent !== "/" && !(await folderExists(env, parent))) return json({ error: "Parent folder not found" }, { status: 404 });
    if (await folderExists(env, folderPath)) return json({ error: "Folder already exists" }, { status: 409 });
    const file = await env.db.prepare("SELECT 1 FROM files WHERE path = ?1 LIMIT 1").bind(folderPath).first();
    if (file) return json({ error: "A file has the same name" }, { status: 409 });
    await env.db.prepare("INSERT INTO directories(path, created_at) VALUES(?1, ?2)").bind(folderPath, Date.now()).run();
    return json({ ok: true, path: folderPath }, { status: 201 });
  }

  if (path === "/api/admin/folders" && req.method === "GET") {
    const [dirs, files] = await Promise.all([
      env.db.prepare("SELECT path FROM directories ORDER BY path").all<{ path: string }>(),
      env.db.prepare("SELECT path FROM files ORDER BY path").all<{ path: string }>(),
    ]);
    const paths = new Set<string>();
    for (const row of dirs.results) {
      const parts = row.path.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) paths.add("/" + parts.slice(0, i).join("/"));
    }
    for (const row of files.results) {
      const parts = row.path.split("/").filter(Boolean);
      for (let i = 1; i < parts.length; i++) paths.add("/" + parts.slice(0, i).join("/"));
    }
    return json({ folders: [...paths].sort((a, b) => a.localeCompare(b)) });
  }

  if (path === "/api/admin/folders" && req.method === "DELETE") {
    const folderPath = validPath(new URL(req.url).searchParams.get("path"));
    if (!folderPath) return json({ error: "Invalid folder path" }, { status: 400 });
    if (!(await folderExists(env, folderPath))) return json({ error: "Folder not found" }, { status: 404 });
    const [lower, upper] = bounds(folderPath);
    const pending = await env.db.prepare(
      `SELECT id, key, r2_upload_id FROM upload_sessions WHERE completed_file_id IS NULL
       AND (path = ?1 OR (path >= ?2 AND path < ?3)) LIMIT 5`
    ).bind(folderPath, lower, upper).all<{ id: string; key: string; r2_upload_id: string }>();
    if (pending.results.length) {
      if (!env.r2) return json({ error: "R2 binding missing" }, { status: 500 });
      for (const session of pending.results) {
        const object = await env.r2.head(session.key);
        if (object) await env.r2.delete(session.key);
        else {
          try { await env.r2.resumeMultipartUpload(session.key, session.r2_upload_id).abort(); }
          catch (error) {
            if (!/NoSuchUpload|10024/.test(String((error as Error)?.message ?? error))) throw error;
          }
        }
        await env.db.batch([
          env.db.prepare("DELETE FROM upload_parts WHERE session_id = ?1").bind(session.id),
          env.db.prepare("DELETE FROM upload_sessions WHERE id = ?1").bind(session.id),
        ]);
      }
      return json({ ok: true, done: false, removed: pending.results.length });
    }
    const files = await env.db.prepare(
      "SELECT id, key FROM files WHERE path >= ?1 AND path < ?2 LIMIT 10"
    ).bind(lower, upper).all<{ id: string; key: string }>();
    if (files.results.length) {
      const st = await createStorageProvider(env, await getSettings(env));
      for (const file of files.results) await st.delete(file.key);
      const ids = files.results.map(file => file.id);
      const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
      await env.db.batch([
        env.db.prepare(`DELETE FROM shares WHERE file_id IN (${placeholders})`).bind(...ids),
        env.db.prepare(`DELETE FROM direct_links WHERE file_id IN (${placeholders})`).bind(...ids),
        env.db.prepare(`DELETE FROM download_logs WHERE file_id IN (${placeholders})`).bind(...ids),
        env.db.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).bind(...ids),
      ]);
      return json({ ok: true, done: false, removed: ids.length });
    }
    await env.db.batch([
      env.db.prepare("DELETE FROM folder_shares WHERE path = ?1 OR (path >= ?2 AND path < ?3)").bind(folderPath, lower, upper),
      env.db.prepare("DELETE FROM directories WHERE path = ?1 OR (path >= ?2 AND path < ?3)").bind(folderPath, lower, upper),
    ]);
    return json({ ok: true, done: true });
  }

  if (path === "/api/admin/folder-shares" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const folderPath = validPath(body.path);
    if (!folderPath) return json({ error: "Invalid folder path" }, { status: 400 });
    if (!(await folderExists(env, folderPath))) return json({ error: "Folder not found" }, { status: 404 });
    const hours = Number(body.expires_hours);
    const maximum = Number(body.max_downloads);
    const password = typeof body.password === "string" ? body.password.trim() : "";
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (note.length > 1000) return json({ error: "Note is too long" }, { status: 400 });
    const id = randomId(10);
    await env.db.prepare(
      `INSERT INTO folder_shares(id, path, created_at, expires_at, max_downloads, password_hash, password_cipher, note)
       VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(id, folderPath, Date.now(), Number.isFinite(hours) && hours > 0 ? Date.now() + hours * 3600_000 : null,
      Number.isSafeInteger(maximum) && maximum > 0 ? maximum : null,
      password ? await hashPassword(password) : null,
      password ? await encryptSecret(password, env.admin) : null, note || null).run();
    return json({ ok: true, id, url: `/f/${id}` }, { status: 201 });
  }

  if (path === "/api/admin/folder-shares" && req.method === "GET") {
    const { results } = await env.db.prepare("SELECT * FROM folder_shares ORDER BY created_at DESC").all<FolderShare>();
    return json({ shares: await Promise.all(results.map(async (row) => ({
      id: row.id, path: row.path, created_at: row.created_at, expires_at: row.expires_at,
      max_downloads: row.max_downloads, download_count: row.download_count, revoked: row.revoked,
      note: row.note,
      status: folderStatus(row) === "ok" ? "active" : folderStatus(row),
      has_password: !!row.password_hash,
      password_plain: row.password_cipher ? await decryptSecret(row.password_cipher, env.admin) : null,
      url: `/f/${row.id}`,
    }))) });
  }

  const match = /^\/api\/admin\/folder-shares\/([A-Za-z0-9]+)$/.exec(path);
  if (match && req.method === "PATCH") {
    const body = await req.json().catch(() => ({})) as { note?: unknown };
    if (typeof body.note !== "string") return json({ error: "Invalid note" }, { status: 400 });
    const note = body.note.trim();
    if (note.length > 1000) return json({ error: "Note is too long" }, { status: 400 });
    const result = await env.db.prepare("UPDATE folder_shares SET note = ?1 WHERE id = ?2")
      .bind(note || null, match[1]).run();
    return json({ ok: (result.meta.changes ?? 0) > 0 }, { status: result.meta.changes ? 200 : 404 });
  }
  if (match && req.method === "DELETE") {
    const result = await env.db.prepare("DELETE FROM folder_shares WHERE id = ?1").bind(match[1]).run();
    return json({ ok: (result.meta.changes ?? 0) > 0 }, { status: result.meta.changes ? 200 : 404 });
  }
  return null;
}

export async function handleFolderPublic(req: Request, env: Env, ctx: ExecutionContext, token: string, action: string, fileId?: string): Promise<Response> {
  const row = await getFolderShare(env, token);
  if (!row) return json({ error: "not_found" }, { status: 404 });
  const status = folderStatus(row);
  const settings = await getSettings(env);
  const url = new URL(req.url);

  if (action === "info" && req.method === "GET") {
    const turnstileEnabled = await isTurnstileEnabled(env, settings);
    const turnstile = getTurnstileInfo(env, settings);
    let needsTurnstile = false;
    if (turnstileEnabled && (turnstile.mode === "on_share" || turnstile.mode === "both")) {
      const ip = clientIp(req);
      const day = new Date().toISOString().slice(0, 10);
      await env.db.prepare("INSERT INTO turnstile_visits(ip, day, count) VALUES(?1, ?2, 1) ON CONFLICT(ip, day) DO UPDATE SET count = count + 1").bind(ip, day).run();
      const visit = await env.db.prepare("SELECT count FROM turnstile_visits WHERE ip = ?1 AND day = ?2").bind(ip, day).first<{ count: number }>();
      needsTurnstile = (visit?.count ?? 1) > settings.turnstileThreshold;
    }
    return json({ status, name: row.path.split("/").pop(), path: row.path,
      needs_password: !!row.password_hash, downloads: row.download_count, max_downloads: row.max_downloads,
      expires_at: row.expires_at, site_title: settings.siteTitle,
      turnstile: { sitekey: turnstile.sitekey, needs_now: needsTurnstile || (turnstileEnabled && (turnstile.mode === "on_download" || turnstile.mode === "both")) },
      oauth: { enabled: settings.oauthEnabled,
        authed: settings.oauthEnabled ? (await verifyOAuthSession(env, req.headers.get("cookie"))).ok : false } });
  }

  if (action === "verify" && req.method === "POST") {
    if (status !== "ok") return json({ error: status }, { status: 410 });
    const body = await req.json().catch(() => ({})) as { password?: string; turnstile?: string };
    if (row.password_hash && !(await verifyPassword(row.password_hash, body.password ?? ""))) return json({ error: "bad_password" }, { status: 401 });
    if (settings.oauthEnabled && !(await verifyOAuthSession(env, req.headers.get("cookie"))).ok) return json({ error: "oauth_required" }, { status: 401 });
    if (await isTurnstileEnabled(env, settings)) {
      const mode = settings.turnstileMode;
      const ip = clientIp(req);
      let needed = mode === "on_download" || mode === "both";
      if (mode === "on_share") {
        const day = new Date().toISOString().slice(0, 10);
        const visit = await env.db.prepare("SELECT count FROM turnstile_visits WHERE ip = ?1 AND day = ?2").bind(ip, day).first<{ count: number }>();
        needed = (visit?.count ?? 0) > settings.turnstileThreshold;
      }
      if (needed && !(await verifyTurnstileToken(env, settings, body.turnstile ?? "", ip))) return json({ error: "turnstile_failed" }, { status: 403 });
    }
    const updated = await env.db.prepare(
      `UPDATE folder_shares SET download_count = download_count + 1
       WHERE id = ?1 AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?2)
       AND (max_downloads IS NULL OR download_count < max_downloads)`
    ).bind(token, Date.now()).run();
    if (!updated.meta.changes) return json({ error: "maxed" }, { status: 410 });
    return json({ ok: true, ticket: await issueToken(env, folderTicket(token)) });
  }

  if (status === "gone" || status === "expired") return json({ error: status }, { status: 410 });
  if (!(await verifyShareToken(env, folderTicket(token), url.search))) return json({ error: "unauthorized" }, { status: 403 });
  if (settings.oauthEnabled && !(await verifyOAuthSession(env, req.headers.get("cookie"))).ok)
    return json({ error: "oauth_required" }, { status: 401 });

  if (action === "manifest" && req.method === "GET") {
    const [files, dirs] = await Promise.all([
      rowsInFolder<FileRow & { path: string }>(env, "files", row.path),
      rowsInFolder<{ path: string }>(env, "directories", row.path),
    ]);
    const directoryPaths = new Set(dirs.map((d) => d.path.slice(row.path.length + 1)));
    for (const file of files) {
      const parts = file.path.slice(row.path.length + 1).split("/");
      for (let i = 1; i < parts.length; i++) directoryPaths.add(parts.slice(0, i).join("/"));
    }
    return json({ name: row.path.split("/").pop(), note: row.note, directories: [...directoryPaths].sort(),
      files: files.map((file) => ({ id: file.id, path: file.path.slice(row.path.length + 1), size: file.size })) });
  }

  if (action === "file" && fileId && (req.method === "GET" || req.method === "HEAD")) {
    const [lower, upper] = bounds(row.path);
    const file = await env.db.prepare(
      "SELECT id, key, name, size, mime, path FROM files WHERE id = ?1 AND path >= ?2 AND path < ?3"
    ).bind(fileId, lower, upper).first<FileRow & { path: string }>();
    if (!file) return json({ error: "file_not_found" }, { status: 404 });
    const ip = clientIp(req);
    const ban = await env.db.prepare("SELECT expires_at FROM banned_ips WHERE ip = ?1").bind(ip).first<{ expires_at: number | null }>();
    if (ban && (!ban.expires_at || ban.expires_at > Date.now())) return json({ error: "banned" }, { status: 403 });
    if (!isAdminWhitelisted(ip, settings.adminIps) && settings.trafficLimitBytes > 0 && settings.trafficUsedBytes >= settings.trafficLimitBytes)
      return json({ error: "traffic_limit" }, { status: 503 });
    const relative = file.path.slice(row.path.length + 1);
    const downloadName = relative.replaceAll("/", "__");
    return streamFile(req, env, ctx, { file_id: file.id, key: file.key, name: file.name, size: file.size,
      mime: file.mime, download_name: downloadName }, token, "share");
  }
  return json({ error: "not_found" }, { status: 404 });
}
