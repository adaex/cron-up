import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  readTasks,
  loadTaskDoc,
  maintainWorkspace,
  minifyIds,
  parseTaskIdN,
  taskKey,
  taskSig,
  atomicWriteJson,
  TaskFileChanged,
} from '../src/tasks.mjs';
import { minTaskIdMaxN } from '../src/cron.mjs';
import { taskView } from '../src/display.mjs';
import { mockDeps, mkTmp, readJson } from '../test-support/helpers.mjs';

const NOW = new Date(2026, 8, 20, 15, 47);

function taskDir(t) {
  const tmp = mkTmp(t);
  const dir = path.join(tmp, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  return { tmp, dir, file: path.join(dir, 'scheduled_tasks.json') };
}

// maintain 的薄接缝：与直接调用保持同一参数形状。
const maintain = (file, opts) => maintainWorkspace(file, opts);

const RECURRING = {
  id: '00000002',
  cron: '0 5 * * *',
  prompt: 'kaboo 上报，结果通过木偶发到群里',
  createdAt: 1790150238473,
  recurring: true,
  createdBySessionId: 'sess-1',
  lastFiredAt: 1790166600547,
};

// ---- readTasks ----

test('shapes that used to crash the patrol read as null or []', (t) => {
  const { tmp } = taskDir(t);
  const target = path.join(tmp, '.claude', 'scheduled_tasks.json');
  for (const text of ['[]', 'null', '"a string"', '42',
    '{"tasks": {"a": 1}}', '{"tasks": "nope"}',
    '{"no_tasks_key": 1}', '{ truncated']) {
    fs.writeFileSync(target, text);
    const result = readTasks(tmp);
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

// ---- renew（无条件补 permanent）----

test('tags recurring and preserves everything else', (t) => {
  const { file } = taskDir(t);
  fs.writeFileSync(file, JSON.stringify({ tasks: [{ ...RECURRING }], version: 7 }));
  const r = maintain(file);
  assert.equal(r.renewed, 1);
  assert.equal(r.reowned, 0);
  const doc = readJson(file);
  const task = doc.tasks[0];
  assert.equal(task.permanent, true);
  for (const [k, v] of Object.entries(RECURRING)) assert.equal(task[k], v);
  assert.equal(doc.version, 7);
});

test('stale tmp from a killed write is swept even when nothing changes', (t) => {
  const { file } = taskDir(t);
  // 全部已标好 → 两项维护 0 改动、不打开写；上轮被杀残留的专属临时文件
  // 仍要被清走。泛用 .tmp 不是我们的东西，不碰。
  fs.writeFileSync(file,
    JSON.stringify({ tasks: [{ ...RECURRING, permanent: true }] }));
  fs.writeFileSync(`${file}.cron-up-tmp`, 'half-written');
  fs.writeFileSync(`${file}.tmp`, 'foreign writer in flight');
  const r = maintain(file);
  assert.deepEqual(r, { renewed: 0, minified: 0, reowned: 0, idChanges: [] });
  assert.equal(fs.existsSync(`${file}.cron-up-tmp`), false);
  assert.equal(fs.existsSync(`${file}.tmp`), true);
});

test('chinese prompt is written literally without unicode escapes', (t) => {
  const { file } = taskDir(t);
  fs.writeFileSync(file, JSON.stringify({ tasks: [{ ...RECURRING }] }));
  maintain(file);
  const text = fs.readFileSync(file, 'utf-8');
  assert.ok(text.includes('群里'));
  assert.ok(!text.includes('\\u'));
});

test('second run is a noop that does not even open for write', (t) => {
  const { file } = taskDir(t);
  fs.writeFileSync(file, JSON.stringify({ tasks: [{ ...RECURRING }] }));
  assert.equal(maintain(file).renewed, 1);
  const first = fs.statSync(file, { bigint: true });
  const r2 = maintain(file);
  assert.deepEqual(r2, { renewed: 0, minified: 0, reowned: 0, idChanges: [] });
  const second = fs.statSync(file, { bigint: true });
  assert.equal(first.ino, second.ino);
  assert.equal(first.mtimeNs, second.mtimeNs);
});

test('only explicit recurring tasks are eligible', (t) => {
  const { file } = taskDir(t);
  fs.writeFileSync(file, JSON.stringify({ tasks: [
    { ...RECURRING },
    { ...RECURRING, id: '00000003', permanent: true },
    { id: '00000004', cron: '0 9 1 1 *', recurring: false },
    { id: '00000005', cron: '0 9 * * *' },
  ] }));
  const r = maintain(file);
  assert.equal(r.renewed, 1);
  const tasks = readJson(file).tasks;
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
    const r = maintain(file);
    assert.deepEqual(r, { renewed: 0, minified: 0, reowned: 0, idChanges: [] },
      String(flag));
    assert.equal(fs.readFileSync(file, 'utf-8'), before);
  }
});

test('malformed documents return null untouched', (t) => {
  for (const text of ['{ broken', '{"tasks": "x"}', '[]', 'null']) {
    const { file } = taskDir(t);
    fs.writeFileSync(file, text);
    assert.equal(maintain(file), null, text);
    assert.equal(fs.readFileSync(file, 'utf-8'), text);
  }
});

test('missing file returns null', (t) => {
  const { file } = taskDir(t);
  assert.equal(maintain(file), null);
});

test('nondict entries and unknown keys survive', (t) => {
  const { file } = taskDir(t);
  fs.writeFileSync(file, JSON.stringify({
    tasks: [{ ...RECURRING }, 'junk', null, 5],
    extraTop: { nested: true },
  }));
  maintain(file);
  const doc = readJson(file);
  assert.deepEqual(doc.extraTop, { nested: true });
  assert.deepEqual(doc.tasks.slice(1), ['junk', null, 5]);
});

test('file mode is preserved', (t) => {
  for (const mode of [0o600, 0o640, 0o644]) {
    const { file } = taskDir(t);
    fs.writeFileSync(file, JSON.stringify({ tasks: [{ ...RECURRING }] }));
    fs.chmodSync(file, mode);
    maintain(file);
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
  assert.deepEqual(readJson(file).tasks, []);
  assert.equal(fs.existsSync(`${file}.cron-up-tmp`), false);
});

test('concurrent change mid-update is not clobbered', (t) => {
  const deps = mockDeps(t);
  const { file } = taskDir(t);
  fs.writeFileSync(file, JSON.stringify({ tasks: [{ ...RECURRING }] }));
  const origLoad = loadTaskDoc;
  deps.loadTaskDoc = (p) => {
    const doc = origLoad(p);
    fs.writeFileSync(p, JSON.stringify({ tasks: [{ id: '00000009' }] }));
    return doc;
  };
  assert.throws(() => maintain(file), TaskFileChanged);
  assert.deepEqual(readJson(file), { tasks: [{ id: '00000009' }] });
  assert.equal(fs.existsSync(`${file}.cron-up-tmp`), false);
});

test('task view exposes the permanent flag', () => {
  const base = { cron: '5 0 * * *', prompt: 'x', createdAt: 0 };
  assert.equal(taskView({ ...base, recurring: true, permanent: true }, NOW)
    .permanent, true);
  assert.equal(taskView({ ...base, recurring: true }, NOW).permanent, false);
  assert.equal(taskView({ ...base, recurring: false, permanent: true }, NOW)
    .permanent, false);
});

// ---- 周期任务 id 改小：无条件、幂等且不碰一次性任务 ----

test('minTaskIdMaxN keeps even the longest cron period within the target', () => {
  const maxN = minTaskIdMaxN();
  assert.equal(maxN, 1_629);
  const longestPeriodMs = 3661 * 86400_000;
  const delayOf = (n) => n / 2 ** 32 * 0.5 * longestPeriodMs;
  assert.ok(delayOf(maxN) <= 60_000);
  assert.ok(delayOf(maxN + 1) > 60_000);

  const id = maxN.toString(16).padStart(8, '0');
  for (const cron of ['0 9 * * 1', '0 9 1 * *']) {
    const v = taskView({ id, cron, recurring: true }, NOW);
    assert.ok(v.fire.getTime() - v.nxt.getTime() <= 60_000, cron);
  }
});

test('parseTaskIdN accepts only strict 8-hex ids', () => {
  assert.equal(parseTaskIdN('00000001'), 1);
  assert.equal(parseTaskIdN('058e0149'), 0x058e0149);
  assert.equal(parseTaskIdN('abc'), null);
  assert.equal(parseTaskIdN('058e0149-aaaa-bbbb'), null);
  assert.equal(parseTaskIdN('zzzzzzzz'), null);
  assert.equal(parseTaskIdN(undefined), null);
  assert.equal(parseTaskIdN(123), null);
});

test('minifyIds assigns free small numbers and reports old and new keys', () => {
  const tasks = [
    { id: '00000001', recurring: false },
    { id: '00000003', recurring: true },
    { id: '554e2879', recurring: true },
    { id: '8c9d6c82', recurring: true },
  ];
  const r = minifyIds(tasks);
  assert.equal(r.changed, 2);
  assert.deepEqual(r.idChanges, [
    { from: '554e2879', to: '00000002' },
    { from: '8c9d6c82', to: '00000004' },
  ]);
  const ids = tasks.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, '文件内 id 唯一');
  assert.equal(tasks[0].id, '00000001', '一次性任务即使占小号也原样保留');
});

test('minifyIds keeps qualifying ids and is idempotent', () => {
  const maxN = minTaskIdMaxN();
  const atEdge = maxN.toString(16).padStart(8, '0');
  const over = (maxN + 1).toString(16).padStart(8, '0');
  const tasks = [
    { id: '00000000', recurring: true },
    { id: atEdge, recurring: true },
    { id: over, recurring: true },
    { id: 'c1363d8b', recurring: false },
    { cron: '0 5 * * *' },
  ];
  const r1 = minifyIds(tasks);
  assert.equal(r1.changed, 1);
  assert.deepEqual(r1.idChanges, [{ from: over, to: '00000001' }]);
  assert.equal(tasks[0].id, '00000000');
  assert.equal(tasks[1].id, atEdge);
  assert.equal(tasks[3].id, 'c1363d8b', '一次性大 id 不改');
  assert.equal(tasks[4].id, undefined, '无 recurring 标志不改');
  const r2 = minifyIds(tasks);
  assert.equal(r2.changed, 0);
  assert.deepEqual(r2.idChanges, []);
});

test('minifyIds leaves a large id alone when all qualifying ids are occupied', () => {
  const maxN = minTaskIdMaxN();
  const tasks = Array.from({ length: maxN }, (_, i) => ({
    id: (i + 1).toString(16).padStart(8, '0'), recurring: false,
  }));
  tasks.push({ id: 'c1363d8b', recurring: true });
  const r = minifyIds(tasks);
  assert.equal(r.changed, 0);
  assert.deepEqual(r.idChanges, []);
  assert.equal(tasks.at(-1).id, 'c1363d8b');
});

test('minifyIds gives a unique anonymous task a real id', () => {
  const original = { cron: '0 5 * * *', prompt: 'x', createdAt: 1,
    recurring: true };
  const tasks = [{ ...original }];
  const r = minifyIds(tasks);
  assert.equal(r.changed, 1);
  assert.deepEqual(r.idChanges, [{ from: taskKey(original), to: '00000001' }]);
  assert.equal(tasks[0].id, '00000001');
});

test('minifyIds skips duplicate original keys instead of hiding ambiguity', () => {
  const a = { id: 'c1363d8b', cron: '0 5 * * *', prompt: '甲', recurring: true };
  const b = { ...a, prompt: '乙' };
  const tasks = [a, b];
  const r = minifyIds(tasks);
  assert.equal(r.changed, 0);
  assert.deepEqual(r.idChanges, []);
  assert.deepEqual(tasks.map((t) => t.id), ['c1363d8b', 'c1363d8b']);
});

// ---- maintainWorkspace：续期与周期任务 id 改小无条件执行 ----

test('maintainWorkspace renews and rewrites a large recurring id', (t) => {
  const { file } = taskDir(t);
  fs.writeFileSync(file, JSON.stringify({
    tasks: [
      { id: 'c1363d8b', cron: '0 13 * * *', recurring: true, prompt: 'x',
        createdAt: 1 },
    ],
    version: 7,
  }));
  const r = maintain(file);
  assert.deepEqual(r, {
    renewed: 1,
    minified: 1,
    reowned: 0,
    idChanges: [{ from: 'c1363d8b', to: '00000001' }],
  });
  const doc = readJson(file);
  assert.equal(doc.tasks[0].id, '00000001');
  assert.equal(doc.tasks[0].permanent, true);
  assert.equal(doc.version, 7, '未知顶层键 round-trip 保留');
});

test('maintainWorkspace returns null on a broken file', (t) => {
  const { file } = taskDir(t);
  fs.writeFileSync(file, '{ broken');
  assert.equal(maintain(file), null);
});

// ---- reown：Map<taskKey, target> 多目标盖印 ----

const WARM_A = { sessionId: 'sess-warm-a', pid: 4321, procStart: 'Fri Oct 16 06:01:20 2026' };
const WARM_B = { sessionId: 'sess-warm-b', pid: 8765, procStart: 'Sat Oct 17 06:02:30 2026' };

test('reown stamps multiple tasks to different warm sessions in one write', (t) => {
  const { file } = taskDir(t);
  const a = { ...RECURRING, id: '00000002', prompt: '甲日报', permanent: true };
  const b = { ...RECURRING, id: '00000004', prompt: '乙日报', permanent: true,
    lastFiredAt: 1792253400874 };
  fs.writeFileSync(file, JSON.stringify({
    tasks: [a, b],
  }));
  const reown = new Map([
    [taskKey(a), WARM_A],
    [taskKey(b), WARM_B],
  ]);
  const r = maintain(file, { reown });
  assert.equal(r.reowned, 2);
  assert.equal(r.renewed, 0);
  const [ta, tb] = readJson(file).tasks;
  assert.equal(ta.createdBySessionId, WARM_A.sessionId);
  assert.equal(ta.createdByPid, WARM_A.pid);
  assert.equal(ta.createdByProcStart, WARM_A.procStart);
  assert.equal(tb.createdBySessionId, WARM_B.sessionId);
  assert.equal(tb.createdByPid, WARM_B.pid);
  assert.equal(tb.createdByProcStart, WARM_B.procStart);
  // 盖印三字段之外一字不动。
  assert.equal(ta.prompt, a.prompt);
  assert.equal(ta.cron, a.cron);
  assert.equal(tb.prompt, b.prompt);
  assert.equal(tb.lastFiredAt, b.lastFiredAt);
});

test('reown covers an entry without an existing owner', (t) => {
  const { file } = taskDir(t);
  const a = { id: '00000002', cron: '0 5 * * *', prompt: 'x',
    createdAt: 1, recurring: true, permanent: true };
  fs.writeFileSync(file, JSON.stringify({ tasks: [a] }));
  const r = maintain(file, { reown: new Map([[taskKey(a), WARM_A]]) });
  assert.equal(r.reowned, 1);
  const ta = readJson(file).tasks[0];
  assert.equal(ta.createdBySessionId, WARM_A.sessionId);
  assert.equal(ta.createdByPid, WARM_A.pid);
  assert.equal(ta.createdByProcStart, WARM_A.procStart);
});

test('reown is idempotent: owner already on target is a byte-level noop', (t) => {
  const { file } = taskDir(t);
  const a = {
    id: '00000002', cron: '0 5 * * *', prompt: 'x', createdAt: 1,
    recurring: true, permanent: true,
    createdBySessionId: WARM_A.sessionId,
    createdByPid: WARM_A.pid,
    createdByProcStart: WARM_A.procStart,
  };
  fs.writeFileSync(file, JSON.stringify({ tasks: [a] }));
  const before = fs.readFileSync(file, 'utf-8');
  const r = maintain(file, { reown: new Map([[taskKey(a), WARM_A]]) });
  assert.deepEqual(r, { renewed: 0, minified: 0, reowned: 0, idChanges: [] });
  assert.equal(fs.readFileSync(file, 'utf-8'), before);
});

test('reown refreshes a stale pid and fingerprint under the same session id', (t) => {
  const { file } = taskDir(t);
  const a = {
    id: '00000002', cron: '0 5 * * *', prompt: 'x',
    createdAt: 1, recurring: true, permanent: true,
    createdBySessionId: WARM_A.sessionId,
    createdByPid: 1,
    createdByProcStart: 'stale',
  };
  fs.writeFileSync(file, JSON.stringify({ tasks: [a] }));
  const r = maintain(file, { reown: new Map([[taskKey(a), WARM_A]]) });
  assert.deepEqual(r, {
    renewed: 0,
    minified: 0,
    reowned: 1,
    idChanges: [],
    reownedTasks: [{ taskId: taskKey(a), target: WARM_A }],
  });
  const ta = readJson(file).tasks[0];
  assert.equal(ta.createdByPid, WARM_A.pid);
  assert.equal(ta.createdByProcStart, WARM_A.procStart);
});

test('reown with identical content but different ids stamps only the target id', (t) => {
  const { file } = taskDir(t);
  const a = { id: '00000002', cron: '0 5 * * *', prompt: '相同内容',
    createdAt: 1, recurring: true, permanent: true };
  const b = { ...a, id: '00000004', createdBySessionId: 'live-creator' };
  fs.writeFileSync(file, JSON.stringify({ tasks: [a, b] }));
  const r = maintain(file, { reown: new Map([[taskKey(a), WARM_A]]) });
  assert.deepEqual(r, {
    renewed: 0,
    minified: 0,
    reowned: 1,
    idChanges: [],
    reownedTasks: [{ taskId: taskKey(a), target: WARM_A }],
  });
  const [ta, tb] = readJson(file).tasks;
  assert.equal(ta.createdBySessionId, WARM_A.sessionId);
  assert.equal(tb.createdBySessionId, 'live-creator');
  assert.equal(tb.createdByPid, undefined);
});

test('reown ignores non-plain task entries', (t) => {
  const { file } = taskDir(t);
  const a = { id: '00000002', cron: '0 5 * * *', prompt: 'x',
    createdAt: 1, recurring: true, permanent: true };
  fs.writeFileSync(file, JSON.stringify({ tasks: ['junk', null, 7, a] }));
  const r = maintain(file, { reown: new Map([[taskKey(a), WARM_A]]) });
  assert.equal(r.reowned, 1, '只有 plain 且任务键命中的 a 被盖');
  assert.deepEqual(readJson(file).tasks.slice(0, 3), ['junk', null, 7]);
});

test('reown skips every entry of a duplicate anonymous task key', (t) => {
  const { file } = taskDir(t);
  const a = { cron: '0 5 * * *', prompt: '无 id 重复', createdAt: 1,
    recurring: true, permanent: true };
  fs.writeFileSync(file, JSON.stringify({ tasks: [a, { ...a }], extra: 7 }));
  const before = fs.readFileSync(file, 'utf-8');
  const r = maintain(file, { reown: new Map([[taskKey(a), WARM_A]]) });
  assert.deepEqual(r, { renewed: 0, minified: 0, reowned: 0, idChanges: [] });
  assert.equal(fs.readFileSync(file, 'utf-8'), before,
    '同键多条不能一起盖，也不应触发写文件');
});

test('renew, minify and reown merge into the same atomic round-trip', (t) => {
  const { file } = taskDir(t);
  const a = { id: 'c1363d8b', cron: '0 13 * * *', recurring: true,
    prompt: 'x', createdAt: 5 };
  fs.writeFileSync(file, JSON.stringify({ tasks: [a] }));
  const r = maintain(file, { reown: new Map([[taskKey(a), WARM_A]]) });
  assert.deepEqual(r, {
    renewed: 1,
    minified: 1,
    reowned: 1,
    idChanges: [{ from: 'c1363d8b', to: '00000001' }],
    reownedTasks: [{ taskId: '00000001', target: WARM_A }],
  });
  const ta = readJson(file).tasks[0];
  assert.equal(ta.permanent, true);
  assert.equal(ta.id, '00000001');
  assert.equal(ta.createdBySessionId, WARM_A.sessionId);
  assert.equal(ta.createdByPid, WARM_A.pid);
});

// ---- taskKey / taskSig ----

test('taskKey prefers a non-empty string id', () => {
  assert.equal(taskKey({ id: '00000002' }), '00000002');
  assert.equal(taskKey({ id: 'c1363d8b' }), 'c1363d8b');
});

test('taskKey falls back to anon: + 16 hex chars of the signature', () => {
  const t = { cron: '0 5 * * *', prompt: 'x', createdAt: 1, recurring: true };
  const key = taskKey(t);
  const expectHash = createHash('sha1').update(taskSig(t)).digest('hex')
    .slice(0, 16);
  assert.equal(key, `anon:${expectHash}`);
  assert.match(key, /^anon:[0-9a-f]{16}$/);
  // 空字符串 id 等同缺失。
  assert.equal(taskKey({ ...t, id: '' }), key);
  assert.equal(taskKey({ ...t, id: 5 }), key);
  assert.equal(taskKey(null), `anon:${createHash('sha1')
    .update(taskSig(null)).digest('hex').slice(0, 16)}`);
});

test('taskSig is stable across id/owner/lastFired/permanent changes', () => {
  const base = { id: 'c1363d8b', cron: '0 5 * * *', prompt: 'x',
    createdAt: 1, recurring: true };
  const s = taskSig(base);
  assert.equal(taskSig({ ...base, id: '00000001' }), s, 'id 不属于内容签名');
  assert.equal(taskSig({ ...base,
    createdBySessionId: 'sid', createdByPid: 1, createdByProcStart: 'p' }), s,
  '盖印改 owner 三字段不变');
  assert.equal(taskSig({ ...base, lastFiredAt: 999 }), s, '执行改 lastFiredAt 不变');
  assert.equal(taskSig({ ...base, permanent: true }), s, '续期加 permanent 不变');
  // recurring 按布尔归一：truthy 与 true 同签名。
  assert.equal(taskSig({ ...base, recurring: 1 }), s);
  assert.equal(taskSig({ ...base, recurring: false }) === s, false);
  // 内容字段任一变化才变签名。
  assert.notEqual(taskSig({ ...base, prompt: 'y' }), s);
  assert.notEqual(taskSig({ ...base, cron: '0 6 * * *' }), s);
  assert.notEqual(taskSig({ ...base, createdAt: 2 }), s);
});
