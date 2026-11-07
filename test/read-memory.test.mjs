import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createMemoryReader } from '../src/read-memory.mjs';

const ID = '012345abcdef';
const LIMIT = 2 * 1024 * 1024;
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-reader-synthetic-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'memory');
  await fs.mkdir(root);
  const put = async (relative, text) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
    return file;
  };
  const read = await createMemoryReader({ memoryDir: root, projectIds: { workspace: ID } });
  return { temp, root, put, read };
}
async function coded(promise, code) {
  await assert.rejects(promise, e => {
    assert.equal(e.code, code);
    assert.equal(e.name, 'MemoryReadError');
    assert.equal(e.cause, undefined);
    assert.ok(!e.message.includes('/') && !e.message.includes('ENOENT'));
    return true;
  });
}

test('reads exactly five fixed scope paths and preserves order', async t => {
  const { put, read } = await fixture(t);
  await put('MEMORY.md', 'global');
  await put('USER.md', 'user');
  await put(`projects/${ID}/KEY.md`, 'key');
  await put(`projects/${ID}/MEMORY.md`, 'project');
  await put('daily/2024-02-29.md', 'daily');
  for (const [request, expected] of [
    [{ scope: 'memory' }, 'global'], [{ scope: 'user' }, 'user'],
    [{ scope: 'key', workspaceId: 'workspace' }, 'key'],
    [{ scope: 'project', workspaceId: 'workspace' }, 'project'],
    [{ scope: 'daily', date: '2024-02-29' }, 'daily'],
  ]) assert.deepEqual(await read(request), [expected]);
});

test('exact delimiter, trimming, empty entries, multiline and unicode', async t => {
  const { put, read } = await fixture(t);
  await put('MEMORY.md', ' \n§\n alpha\nline \n§\n\n§\n 日本語 § inline\n§\n ');
  assert.deepEqual(await read({ scope: 'memory' }), ['alpha\nline', '日本語 § inline']);
  await put('MEMORY.md', 'a\r\n§\r\nb');
  assert.deepEqual(await read({ scope: 'memory' }), ['a\r\n§\r\nb']);
  await put('MEMORY.md', ' \n');
  assert.deepEqual(await read({ scope: 'memory' }), []);
});

test('missing leaves and missing regular ancestry return empty without discovery', async t => {
  const { put, read } = await fixture(t);
  await put('MEMORY-archive.md', 'never returned');
  await put('AGENTS.md', 'never returned');
  await put('pending/MEMORY.md', 'never returned');
  for (const request of [{ scope: 'memory' }, { scope: 'user' },
    { scope: 'key', workspaceId: 'workspace' }, { scope: 'daily', date: '2000-01-01' }]) {
    assert.deepEqual(await read(request), []);
  }
});

test('strict dates including century rules, year bounds, and traversal', async t => {
  const { read } = await fixture(t);
  for (const date of ['2023-02-29', '1900-02-29', '2024-04-31', '2024-00-10', '2024-13-01',
    '0000-01-01', '2024-01-00', '2024-1-01', '../USER', '2024-01-01/../USER', '', null, 20240101]) {
    await coded(read({ scope: 'daily', date }), 'INVALID_ARGUMENT');
  }
  for (const date of ['2000-02-29', '0001-01-01', '9999-12-31']) {
    assert.deepEqual(await read({ scope: 'daily', date }), []);
  }
});

test('rejects unsupported scopes and path/extra argument injection', async t => {
  const { read } = await fixture(t);
  for (const request of [undefined, null, [], {}, { scope: '../USER.md' }, { scope: 'archive' },
    { scope: 'todo' }, { scope: 'agents' }, { scope: 'memory', path: '/tmp/secret' },
    { scope: 'memory', date: '2024-01-01' }, { scope: 'user', workspaceId: 'workspace' },
    { scope: 'daily', date: '2024-01-01', workspaceId: 'workspace' },
    { scope: 'key', workspaceId: '../secret' }, { scope: 'project', workspaceId: 'unknown' },
    { scope: 'key', workspaceId: 'workspace', date: '2024-01-01' }]) {
    await coded(read(request), 'INVALID_ARGUMENT');
  }
});

test('requires explicit root and valid pinned project map; map copied once', async t => {
  const { root, put } = await fixture(t);
  for (const options of [{}, { memoryDir: 'relative', projectIds: {} },
    { memoryDir: root }, { memoryDir: root, projectIds: [] },
    ...['ABCDEF012345', '012345abcde', '../012345abc', '012345abcdef0', null].map(id => ({ memoryDir: root, projectIds: { workspace: id } })),
    { memoryDir: root, projectIds: {}, path: '/tmp/secret' }]) {
    await coded(createMemoryReader(options), 'INVALID_ARGUMENT');
  }
  const ids = { workspace: ID };
  const read = await createMemoryReader({ memoryDir: root, projectIds: ids });
  ids.workspace = 'ffffffffffff';
  await put(`projects/${ID}/KEY.md`, 'pinned');
  assert.deepEqual(await read({ scope: 'key', workspaceId: 'workspace' }), ['pinned']);
  const mapRead = await createMemoryReader({ memoryDir: root, projectIds: new Map([['workspace', ID]]) });
  assert.deepEqual(await mapRead({ scope: 'key', workspaceId: 'workspace' }), ['pinned']);
  await coded(read({ scope: 'key', workspaceId: 'toString' }), 'INVALID_ARGUMENT');
});

test('denies leaf symlinks, dangling symlinks, directories and regular-file ancestors', async t => {
  const { root, temp, read } = await fixture(t);
  const other = path.join(temp, 'other');
  await fs.writeFile(other, 'not readable via link');
  await fs.symlink(other, path.join(root, 'MEMORY.md'));
  await coded(read({ scope: 'memory' }), 'READ_UNAVAILABLE');
  await fs.symlink(path.join(temp, 'absent'), path.join(root, 'USER.md'));
  await coded(read({ scope: 'user' }), 'READ_UNAVAILABLE');
  await fs.mkdir(path.join(root, 'daily'));
  await fs.mkdir(path.join(root, 'daily', '2024-01-01.md'));
  await coded(read({ scope: 'daily', date: '2024-01-01' }), 'READ_UNAVAILABLE');
  await fs.writeFile(path.join(root, 'projects'), 'not a directory');
  await coded(read({ scope: 'key', workspaceId: 'workspace' }), 'READ_UNAVAILABLE');
});

test('denies symlink ancestors even when target missing, including project ID directory', async t => {
  const { root, temp, read } = await fixture(t);
  await fs.symlink(temp, path.join(root, 'daily'));
  await coded(read({ scope: 'daily', date: '2024-01-01' }), 'READ_UNAVAILABLE');
  await fs.mkdir(path.join(root, 'projects'));
  await fs.symlink(temp, path.join(root, 'projects', ID));
  await coded(read({ scope: 'project', workspaceId: 'workspace' }), 'READ_UNAVAILABLE');
});

test('rejects direct symlink root and revalidates root replacement on every read', async t => {
  const { root, temp, put, read } = await fixture(t);
  await put('MEMORY.md', 'old');
  const alias = path.join(temp, 'alias');
  await fs.symlink(root, alias);
  await coded(createMemoryReader({ memoryDir: alias, projectIds: {} }), 'READ_UNAVAILABLE');
  await coded(createMemoryReader({ memoryDir: `${alias}/`, projectIds: {} }), 'READ_UNAVAILABLE');
  await fs.rename(root, path.join(temp, 'old-root'));
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'MEMORY.md'), 'new');
  await coded(read({ scope: 'memory' }), 'STALE_READ');
});

test('canonicalizes initial ancestor aliases once and does not later follow them', async t => {
  const { root, temp } = await fixture(t);
  const alias = path.join(temp, 'ancestor-alias');
  await fs.symlink(temp, alias);
  const read = await createMemoryReader({ memoryDir: path.join(alias, 'memory'), projectIds: {} });
  await fs.unlink(alias);
  await fs.writeFile(path.join(root, 'USER.md'), 'canonical');
  assert.deepEqual(await read({ scope: 'user' }), ['canonical']);
});

test('enforces byte and entry boundaries and rejects invalid UTF-8', async t => {
  const { put, read } = await fixture(t);
  await put('MEMORY.md', 'a'.repeat(LIMIT));
  assert.equal((await read({ scope: 'memory' }))[0].length, LIMIT);
  await put('MEMORY.md', 'a'.repeat(LIMIT + 1));
  await coded(read({ scope: 'memory' }), 'READ_TOO_LARGE');
  await put('MEMORY.md', Array(5000).fill('x').join('\n§\n'));
  assert.equal((await read({ scope: 'memory' })).length, 5000);
  await put('MEMORY.md', Array(5001).fill('x').join('\n§\n'));
  await coded(read({ scope: 'memory' }), 'READ_TOO_LARGE');
  await put('MEMORY.md', Buffer.from([0xff]));
  await coded(read({ scope: 'memory' }), 'READ_UNAVAILABLE');
});

test('growing file cannot cause more than cap+1 bytes to be read', async t => {
  const { put, read } = await fixture(t);
  const target = await put('MEMORY.md', 'initial');
  const originalOpen = fs.open;
  let totalRead = 0;
  let grew = false;
  const patch = t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      if (!grew) { grew = true; await fs.appendFile(target, 'x'.repeat(LIMIT)); }
      const result = await originalRead(...readArgs);
      totalRead += result.bytesRead;
      return result;
    };
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await coded(read({ scope: 'memory' }), 'READ_TOO_LARGE');
    assert.equal(totalRead, LIMIT + 1);
  } finally { patch.mock.restore(); syncBuiltinESMExports(); }
});

test('unrelated sibling creation during read does not invalidate directory ancestry', async t => {
  const { root, put, read } = await fixture(t);
  await put(`projects/${ID}/KEY.md`, 'unchanged');
  const originalOpen = fs.open;
  let added = false;
  const patch = t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await originalRead(...readArgs);
      if (!added) {
        added = true;
        // Mutate both root and a nested ancestor without replacing either.
        await fs.mkdir(path.join(root, 'unrelated'));
        await put(`projects/${ID}/unrelated.md`, 'sibling');
      }
      return result;
    };
    return handle;
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await read({ scope: 'key', workspaceId: 'workspace' }), ['unchanged']);
    assert.equal(added, true);
  } finally { patch.mock.restore(); syncBuiltinESMExports(); }
});

test('ancestor replacement during read is detected', async t => {
  const { root, put, read } = await fixture(t);
  await put(`projects/${ID}/KEY.md`, 'original');
  const originalOpen = fs.open;
  let swapped = false;
  const patch = t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await originalRead(...readArgs);
      if (!swapped) {
        swapped = true;
        await fs.rename(path.join(root, 'projects'), path.join(root, 'old-projects'));
        await put(`projects/${ID}/KEY.md`, 'new');
      }
      return result;
    };
    return handle;
  });
  syncBuiltinESMExports();
  try { await coded(read({ scope: 'key', workspaceId: 'workspace' }), 'STALE_READ'); }
  finally { patch.mock.restore(); syncBuiltinESMExports(); }
});

test('bounded cap+1 reads and deterministic leaf replacement during read fail closed', async t => {
  const { put, read } = await fixture(t);
  const target = await put('MEMORY.md', 'old');
  const originalOpen = fs.open;
  let requested = 0;
  const patch = t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    handle.read = async (buffer, offset, length, position) => {
      requested += length;
      assert.ok(buffer.length <= LIMIT + 1);
      const result = await originalRead(buffer, offset, Math.min(length, 2), position);
      if (position === 0) {
        await fs.rename(target, `${target}.old`);
        await fs.writeFile(target, 'replacement');
      }
      return result;
    };
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await coded(read({ scope: 'memory' }), 'STALE_READ');
    assert.ok(requested > 0);
  } finally { patch.mock.restore(); syncBuiltinESMExports(); }
});
