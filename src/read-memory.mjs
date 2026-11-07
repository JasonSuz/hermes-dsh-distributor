import { constants } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const messages = {
  INVALID_ARGUMENT: 'Invalid memory read argument',
  READ_UNAVAILABLE: 'Memory read unavailable',
  READ_TOO_LARGE: 'Memory read exceeds limits',
  STALE_READ: 'Memory changed during read',
};
class MemoryReadError extends Error {
  constructor(code) { super(messages[code]); this.name = 'MemoryReadError'; this.code = code; }
}
const fail = code => { throw new MemoryReadError(code); };
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameStat = (a, b) => sameInode(a, b) && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const stat = p => lstat(p, { bigint: true });
const missing = e => e?.code === 'ENOENT';
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exactKeys(value, keys) {
  if (!record(value) || Reflect.ownKeys(value).some(k => !keys.includes(k))) fail('INVALID_ARGUMENT');
}
function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}
async function boundary(action) {
  try { return await action(); }
  catch (e) { if (e instanceof MemoryReadError) throw e; fail('READ_UNAVAILABLE'); }
}

/**
 * Standalone read-only file adapter. projectIds is an admin-pinned object/Map;
 * workspace ID validation and authorization belong to the caller. No path,
 * git-root discovery, archive access, scanning, or writes are supported.
 * The explicit absolute root is canonicalized once (e.g. macOS /var aliases).
 * Its final component must not be a symlink. Canonical ancestry is checked on
 * every read, and the root inode is pinned for this reader's lifetime.
 *
 * SECURITY LIMIT: Node path-based lstat/realpath/open are NOT dirfd-relative
 * traversal. O_NOFOLLOW protects the leaf; before/after ancestry, inode and
 * stat checks detect ordinary replacement, not every malicious same-user
 * swap-and-restore of an ancestor between syscalls. Use OS isolation against
 * an adversarial same-user writer; this adapter does not promise that boundary.
 *
 * @param {{memoryDir: string, projectIds: Record<string, string>|Map<string,string>}} options
 * @returns {Promise<(request: {scope: string, workspaceId?: string, date?: string}) => Promise<string[]>>}
 */
export async function createMemoryReader(options) {
  return boundary(async () => {
    exactKeys(options, ['memoryDir', 'projectIds']);
    const { memoryDir, projectIds } = options;
    if (typeof memoryDir !== 'string' || !path.isAbsolute(memoryDir) || memoryDir.includes('\0')) fail('INVALID_ARGUMENT');
    if (!(projectIds instanceof Map) && !record(projectIds)) fail('INVALID_ARGUMENT');
    const ids = new Map(projectIds instanceof Map ? projectIds : Object.entries(projectIds));
    for (const [workspace, id] of ids) {
      if (typeof workspace !== 'string' || !workspace || typeof id !== 'string' || !/^[a-f0-9]{12}$/.test(id)) fail('INVALID_ARGUMENT');
    }
    if (typeof constants.O_NOFOLLOW !== 'number') fail('READ_UNAVAILABLE');
    // Remove trailing separators before lstat: lstat('link/') follows a directory
    // symlink on POSIX even though lstat('link') does not.
    const suppliedPath = memoryDir.replace(/\/+$/, '') || '/';
    const supplied = await stat(suppliedPath);
    if (!supplied.isDirectory() || supplied.isSymbolicLink()) fail('READ_UNAVAILABLE');
    const root = await realpath(suppliedPath);
    const rootPin = await stat(root);
    if (!rootPin.isDirectory() || !sameInode(supplied, rootPin)) fail('READ_UNAVAILABLE');
    const rootParts = [path.parse(root).root];
    for (const part of root.slice(path.parse(root).root.length).split(path.sep).filter(Boolean)) {
      rootParts.push(path.join(rootParts.at(-1), part));
    }
    async function ancestry(parts, stale = false) {
      const result = [];
      for (const p of parts) {
        const s = await stat(p);
        if (!s.isDirectory() || s.isSymbolicLink()) fail(stale ? 'STALE_READ' : 'READ_UNAVAILABLE');
        result.push([p, s]);
      }
      if (await realpath(root) !== root || !sameInode(result[rootParts.length - 1][1], rootPin)) fail('STALE_READ');
      return result;
    }
    await ancestry(rootParts);
    return async function read(request) {
      return boundary(async () => {
        exactKeys(request, ['scope', 'workspaceId', 'date']);
        const { scope, workspaceId, date } = request;
        let relative;
        if (scope === 'memory' || scope === 'user') {
          if (workspaceId !== undefined || date !== undefined) fail('INVALID_ARGUMENT');
          relative = scope === 'memory' ? ['MEMORY.md'] : ['USER.md'];
        } else if (scope === 'key' || scope === 'project') {
          if (typeof workspaceId !== 'string' || !ids.has(workspaceId) || date !== undefined) fail('INVALID_ARGUMENT');
          relative = ['projects', ids.get(workspaceId), scope === 'key' ? 'KEY.md' : 'MEMORY.md'];
        } else if (scope === 'daily') {
          if (!calendarDate(date) || workspaceId !== undefined) fail('INVALID_ARGUMENT');
          relative = ['daily', `${date}.md`];
        } else fail('INVALID_ARGUMENT');
        const before = await ancestry(rootParts);
        let target = root;
        let absent;
        let leaf;
        for (let i = 0; i < relative.length; i++) {
          target = path.join(target, relative[i]);
          let s;
          try { s = await stat(target); }
          catch (e) { if (!missing(e)) throw e; absent = target; break; }
          if (s.isSymbolicLink() || (i < relative.length - 1 ? !s.isDirectory() : !s.isFile())) fail('READ_UNAVAILABLE');
          if (i === relative.length - 1) leaf = s;
          else before.push([target, s]);
        }
        async function verify() {
          await ancestry(rootParts, true);
          for (const [p, s] of before) {
            let now;
            try { now = await stat(p); } catch { fail('STALE_READ'); }
            // Sibling creation legitimately changes directory size/mtime/ctime.
            // Keep directory inode/type/mode pinned; full stat checks are for leaves.
            if (!now.isDirectory() || !sameInode(s, now)) fail('STALE_READ');
          }
        }
        if (absent) {
          await verify();
          try { await stat(absent); } catch (e) { if (missing(e)) return []; throw e; }
          fail('STALE_READ');
        }
        if (leaf.size > BigInt(MAX_BYTES)) fail('READ_TOO_LARGE');
        let handle;
        try {
          // O_NONBLOCK also prevents blocking if a regular leaf races into a FIFO.
          handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const opened = await handle.stat({ bigint: true });
          if (!opened.isFile() || !sameStat(leaf, opened)) fail('STALE_READ');
          await verify();
          const buffer = Buffer.alloc(MAX_BYTES + 1);
          let used = 0;
          while (used < buffer.length) {
            const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
            if (bytesRead === 0) break;
            used += bytesRead;
          }
          if (used > MAX_BYTES) fail('READ_TOO_LARGE');
          if (!sameStat(opened, await handle.stat({ bigint: true }))) fail('STALE_READ');
          await verify();
          let current;
          try { current = await stat(target); } catch { fail('STALE_READ'); }
          if (!current.isFile() || !sameStat(opened, current)) fail('STALE_READ');
          let text;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used)); }
          catch { fail('READ_UNAVAILABLE'); }
          const entries = text.split('\n§\n').map(entry => entry.trim()).filter(Boolean);
          if (entries.length > MAX_ENTRIES) fail('READ_TOO_LARGE');
          return entries;
        } finally { if (handle) await handle.close(); }
      });
    };
  });
}
