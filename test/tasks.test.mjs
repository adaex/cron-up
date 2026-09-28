import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  readTasks,
  loadTaskDoc,
  renewWorkspace,
  atomicWriteJson,
  TaskFileChanged,
} from '../src/tasks.mjs';
import { taskView } from '../src/display.mjs';
import { mockDeps } from '../test-support/helpers.mjs';

const NOW = new Date(2026, 8, 20, 15, 47);

function taskDir(t) {
  const tmp = fs.mkdtempSync(path.join('/tmp', 'cr-renew-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dir = path.join(tmp, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  return { tmp, dir, file: path.join(dir, 'scheduled_tasks.json') };
}

// ---- readTasks ----

test('shapes that used to crash the patrol read as null or []', (t) => {
  const { tmp } = taskDir(t);
  const ws = tmp;
  const target = path.join(ws, '.claude', 'scheduled_tasks.json');
  for (const text of ['[]', 'null', '"a string"', '42',
    '{"tasks": {"a": 1}}', '{"tasks": "nope"}',
    '{"no_tasks_key": 1}', '{ truncated']) {
    fs.writeFileSync(target, text);
    const result = readTasks(ws);
    assert.ok(result === null || Array.isArray(result), text);
  }
});

test('non-dict entries are dropped', (t) => {
  const { tmp } = taskDir(t);
  fs.writeFileSync(path.join(tmp, '.claude', 'scheduled_tasks.json'),
    '{"tasks": [{"cron": "0 9 * * *"}, "junk", null, 7]}');
  assert.deepEqual(readTasks(tmp), [{ cron: '0 9 * * *' }]);
});

test('missing file reads as null', (t) => {
  const { tmp } = taskDir(t);
  assert.equal(readTasks(path.join(tmp, 'nonexistent')), null);
});

// ---- renew ----

const RECURRING = {
  id: 'abc',
  cron: '0 5 * * *',
  prompt: 'kaboo 上报，结果通过木偶发到群里',
  createdAt: 1790150238473,
  recurring: true,
  createdBySessionId: 'sess-1',
  lastFiredAt: 1790166600547,
};

test('tags recurring and preserves everything else', (t) => {
  const { file } = taskDir(t);
  fs.writeFileSync(file, JSON.stringify({ tasks: [{ ...RECURRING }], version: 7 }));
  assert.equal(renewWorkspace(file), 1);
  const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const task = doc.tasks[0];
  assert.equal(task.permanent, true);
  for (const [k, v] of Object.entries(RECURRING)) assert.equal(task[k], v);
  assert.equal(doc.version, 7);
});

test('chinese prompt is written literally', (t) => {
  const { file } = taskDir(t);
  fs.writeFileSync(file, JSON.stringify({ tasks: [{ ...RECURRING }] }));
  renewWorkspace(file);
  const text = fs.readFileSync(file, 'utf-8');
  assert.ok(text.includes('群里'));
  assert.ok(!text.includes('\\u'));
});

test('second run is a noop that does not even open for write', (t) => {
  const { file } = taskDir(t);
  fs.writeFileSync(file, JSON.stringify({ tasks: [{ ...RECURRING }] }));
  assert.equal(renewWorkspace(file), 1);
  const first = fs.statSync(file, { bigint: true });
  assert.equal(renewWorkspace(file), 0);
  const second = fs.statSync(file, { bigint: true });
  assert.equal(first.ino, second.ino);
  assert.equal(first.mtimeNs, second.mtimeNs);
});

test('only explicit recurring tasks are eligible', (t) => {
  const { file } = taskDir(t);
  fs.writeFileSync(file, JSON.stringify({ tasks: [
    { ...RECURRING },
    { ...RECURRING, id: 'already', permanent: true },
    { id: 'oneshot', cron: '0 9 1 1 *', createdAt: 1, recurring: false },
    { id: 'flagless', cron: '0 9 * * *', createdAt: 1 },
  ] }));
  assert.equal(renewWorkspace(file), 1);
  const tasks = JSON.parse(fs.readFileSync(file, 'utf-8')).tasks;
  assert.equal(tasks[0].permanent, true);
  assert.equal(tasks[1].permanent, true);
  assert.equal('permanent' in tasks[2], false);
  assert.equal('permanent' in tasks[3], false);
});

test('any truthy permanent is already exempt', (t) => {
  for (const flag of [true, 'yes', 1]) {
    const { file } = taskDir(t);
    fs.writeFileSync(file, JSON.stringify({ tasks: [{ ...RECURRING, permanent: flag }] }));
    const before = fs.readFileSync(file, 'utf-8');
    assert.equal(renewWorkspace(file), 0, String(flag));
    assert.equal(fs.readFileSync(file, 'utf-8'), before);
  }
});

test('malformed documents return null untouched', (t) => {
  for (const text of ['{ broken', '{"tasks": "x"}', '[]', 'null']) {
    const { file } = taskDir(t);
    fs.writeFileSync(file, text);
    assert.equal(renewWorkspace(file), null, text);
    assert.equal(fs.readFileSync(file, 'utf-8'), text);
  }
});

test('missing file returns null', (t) => {
  const { file } = taskDir(t);
  assert.equal(renewWorkspace(file), null);
});

test('nondict entries and unknown keys survive', (t) => {
  const { file } = taskDir(t);
  fs.writeFileSync(file, JSON.stringify({
    tasks: [{ ...RECURRING }, 'junk', null, 5],
    extraTop: { nested: true },
  }));
  renewWorkspace(file);
  const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepEqual(doc.extraTop, { nested: true });
  assert.deepEqual(doc.tasks.slice(1), ['junk', null, 5]);
});

test('file mode is preserved', (t) => {
  for (const mode of [0o600, 0o640, 0o644]) {
    const { file } = taskDir(t);
    fs.writeFileSync(file, JSON.stringify({ tasks: [{ ...RECURRING }] }));
    fs.chmodSync(file, mode);
    renewWorkspace(file);
    assert.equal(fs.statSync(file).mode & 0o777, mode, mode.toString(8));
  }
});

test('atomic write refuses a stale mtime', (t) => {
  const { file } = taskDir(t);
  fs.writeFileSync(file, JSON.stringify({ tasks: [{ ...RECURRING }] }));
  const staleMtime = fs.statSync(file, { bigint: true }).mtimeNs;
  fs.writeFileSync(file, JSON.stringify({ tasks: [] })); // 更新的写者
  assert.throws(
    () => atomicWriteJson(file, { tasks: [{ x: 1 }] }, staleMtime),
    TaskFileChanged);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).tasks, []);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('concurrent change mid-update is not clobbered', (t) => {
  const deps = mockDeps(t);
  const { file } = taskDir(t);
  fs.writeFileSync(file, JSON.stringify({ tasks: [{ ...RECURRING }] }));
  const origLoad = loadTaskDoc;
  deps.loadTaskDoc = (p) => {
    const doc = origLoad(p);
    fs.writeFileSync(p, JSON.stringify({ tasks: [{ id: 'cc-wins' }] }));
    return doc;
  };
  assert.throws(() => renewWorkspace(file), TaskFileChanged);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')),
    { tasks: [{ id: 'cc-wins' }] });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('task view exposes the permanent flag', () => {
  const base = { cron: '5 0 * * *', prompt: 'x', createdAt: 0 };
  assert.equal(taskView({ ...base, recurring: true, permanent: true }, NOW)
    .permanent, true);
  assert.equal(taskView({ ...base, recurring: true }, NOW).permanent, false);
  assert.equal(taskView({ ...base, recurring: false, permanent: true }, NOW)
    .permanent, false);
});
