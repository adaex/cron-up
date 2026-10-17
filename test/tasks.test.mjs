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
  minTaskIdMaxN,
  taskKey,
  taskSig,
  atomicWriteJson,
  TaskFileChanged,
} from '../src/tasks.mjs';
import { taskView } from '../src/display.mjs';
import { mockDeps, mkTmp, readJson } from '../test-support/helpers.mjs';

const NOW = new Date(2026, 8, 20, 15, 47);

function taskDir(t) {
  const tmp = mkTmp(t);
  const dir = path.join(tmp, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  return { tmp, dir, file: path.join(dir, 'scheduled_tasks.json') };
}

// renew/minify 合并入口的薄接缝：绝大多数用例只关心 renewed。
const maintain = (file, opts) => maintainWorkspace(file, opts);

// 已是小 id 的周期任务：minify 对它无改动，纯 renew 用例不被改 id 干扰。
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
  assert.equal(r.minified, 0, '小 id 不触发改 id');
  assert.deepEqual(r.idChanges, []);
  const doc = readJson(file);
  const task = doc.tasks[0];
  assert.equal(task.permanent, true);
  for (const [k, v] of Object.entries(RECURRING)) assert.equal(task[k], v);
  assert.equal(doc.version, 7);
});

test('stale tmp from a killed write is swept even when nothing changes', (t) => {
  const { file } = taskDir(t);
  // 全部已标好且 id 已小 → 三项维护 0 改动、不打开写；上轮被杀残留的专
  // 属临时文件仍要被清走。泛用 .tmp 不是我们的东西，不碰。
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
  assert.equal(r.minified, 0);
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

// ---- autoMinId：id 改小（返回 {changed, idChanges}）----

test('minTaskIdMaxN keeps daily delay within the target', () => {
  const maxN = minTaskIdMaxN();
  assert.equal(maxN, 5_965_232); // floor(60s / (0.5·86400s) · 2^32)
  const delayOf = (n) => n / 2 ** 32 * 0.5 * 86400_000;
  assert.ok(delayOf(maxN) <= 60_000);
  assert.ok(delayOf(maxN + 1) > 60_000);
});

test('parseTaskIdN accepts only strict 8-hex ids', () => {
  assert.equal(parseTaskIdN('00000001'), 1);
  assert.equal(parseTaskIdN('058e0149'), 0x058e0149);
  assert.equal(parseTaskIdN('abc'), null);          // 太短
  assert.equal(parseTaskIdN('058e0149-aaaa-bbbb'), null); // UUID 长串
  assert.equal(parseTaskIdN('zzzzzzzz'), null);     // 非 hex
  assert.equal(parseTaskIdN(undefined), null);
  assert.equal(parseTaskIdN(123), null);
});

test('minifyIds assigns free small numbers and reports idChanges', () => {
  const tasks = [
    { id: 'c1363d8b', recurring: true },
    { id: '668aafd9', recurring: true },
  ];
  const r = minifyIds(tasks);
  assert.equal(r.changed, 2);
  assert.deepEqual(r.idChanges, [
    { from: 'c1363d8b', to: '00000001' },
    { from: '668aafd9', to: '00000002' },
  ]);
  assert.equal(tasks[0].id, '00000001');
  assert.equal(tasks[1].id, '00000002');
});

test('minifyIds never reuses an id already taken in the file', () => {
  // 一个一次性任务占着 00000001，另一个达标周期任务占着 00000003：大 id
  // 周期任务只能拿空号 00000002。
  const tasks = [
    { id: '00000001', recurring: false },
    { id: '00000003', recurring: true },
    { id: 'c1363d8b', recurring: true },
  ];
  const r = minifyIds(tasks);
  assert.equal(r.changed, 1);
  assert.deepEqual(r.idChanges, [{ from: 'c1363d8b', to: '00000002' }]);
  const ids = tasks.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, '文件内 id 唯一');
});

test('minifyIds reports an anon: from-key when the task has no id', () => {
  // 手写任务可能根本没有 id：from 走内容摘要键，而不是 undefined。
  const tasks = [{ cron: '0 5 * * *', prompt: 'x', createdAt: 1,
    recurring: true }];
  const r = minifyIds(tasks);
  assert.equal(r.changed, 1);
  assert.match(r.idChanges[0].from, /^anon:[0-9a-f]{16}$/);
  assert.equal(r.idChanges[0].to, '00000001');
  // from 是改 id 前的内容键（tasks[0] 此刻已被改成新 id，用原始内容复算）。
  assert.equal(r.idChanges[0].from, taskKey(
    { cron: '0 5 * * *', prompt: 'x', createdAt: 1, recurring: true }));
});

test('minifyIds keeps qualifying ids and is idempotent', () => {
  const maxN = minTaskIdMaxN();
  const atEdge = maxN.toString(16).padStart(8, '0');
  const over = (maxN + 1).toString(16).padStart(8, '0');
  const tasks = [
    { id: '00000000', recurring: true }, // hash 0，延迟 0
    { id: atEdge, recurring: true },     // 恰好达标
    { id: over, recurring: true },       // 超界 1 号
    { id: 'c1363d8b', recurring: false }, // 一次性：再大也不动
    { cron: '0 5 * * *' },               // 无 recurring 标志：不碰
  ];
  const r1 = minifyIds(tasks);
  assert.equal(r1.changed, 1);
  assert.deepEqual(r1.idChanges.map((c) => c.to), ['00000001']);
  assert.equal(tasks[0].id, '00000000');
  assert.equal(tasks[1].id, atEdge);
  assert.equal(tasks[2].id, '00000001');
  assert.equal(tasks[3].id, 'c1363d8b');
  assert.equal(tasks[4].id, undefined);
  // 第二轮：全部达标，0 改动。
  const r2 = minifyIds(tasks);
  assert.equal(r2.changed, 0);
  assert.deepEqual(r2.idChanges, []);
});

// ---- maintainWorkspace：renew + minify 无条件合并 ----

test('maintainWorkspace does renew and minify together unconditionally', (t) => {
  const { file } = taskDir(t);
  fs.writeFileSync(file, JSON.stringify({
    tasks: [
      { id: 'c1363d8b', cron: '0 13 * * *', recurring: true, prompt: 'x',
        createdAt: 1 },
    ],
    version: 7,
  }));
  const r = maintain(file);
  assert.equal(r.renewed, 1);
  assert.equal(r.minified, 1);
  assert.equal(r.reowned, 0);
  assert.deepEqual(r.idChanges, [{ from: 'c1363d8b', to: '00000001' }]);
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

// ---- reown：Map<taskSig, target> 多目标盖印 ----

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
    [taskSig(a), WARM_A],
    [taskSig(b), WARM_B],
  ]);
  const r = maintain(file, { reown });
  assert.equal(r.reowned, 2);
  assert.equal(r.renewed, 0);
  assert.equal(r.minified, 0);
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
  const r = maintain(file, { reown: new Map([[taskSig(a), WARM_A]]) });
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
  const r = maintain(file, { reown: new Map([[taskSig(a), WARM_A]]) });
  assert.deepEqual(r, { renewed: 0, minified: 0, reowned: 0, idChanges: [] });
  assert.equal(fs.readFileSync(file, 'utf-8'), before);
});

test('reown ignores tasks whose signature is not in the map', (t) => {
  const { file } = taskDir(t);
  const a = { id: '00000002', cron: '0 5 * * *', prompt: 'x',
    createdAt: 1, recurring: true, permanent: true,
    createdBySessionId: 'someone-else' };
  fs.writeFileSync(file, JSON.stringify({ tasks: [a] }));
  // Map 里是另一条任务的签名：盖不到，也不该写文件。
  const r = maintain(file, { reown: new Map([
    [taskSig({ ...a, prompt: '完全不同的内容' }), WARM_A],
  ]) });
  assert.equal(r.reowned, 0);
  assert.equal(readJson(file).tasks[0].createdBySessionId, 'someone-else');
});

test('reown ignores non-plain task entries', (t) => {
  const { file } = taskDir(t);
  const a = { id: '00000002', cron: '0 5 * * *', prompt: 'x',
    createdAt: 1, recurring: true, permanent: true };
  fs.writeFileSync(file, JSON.stringify({ tasks: ['junk', null, 7, a] }));
  const r = maintain(file, { reown: new Map([[taskSig(a), WARM_A]]) });
  assert.equal(r.reowned, 1, '只有 plain 且签名命中的 a 被盖');
  assert.deepEqual(readJson(file).tasks.slice(0, 3), ['junk', null, 7]);
});

test('renew, minify and reown merge into the same atomic round-trip', (t) => {
  const { file } = taskDir(t);
  // 大 id（要改小）、未 permanent（要续期），reown 的 key 用改 id 前的任
  // 务内容算——签名不含 id，minify 之后仍命中盖印。
  const a = { id: 'c1363d8b', cron: '0 13 * * *', recurring: true,
    prompt: 'x', createdAt: 5 };
  fs.writeFileSync(file, JSON.stringify({ tasks: [a] }));
  const r = maintain(file, { reown: new Map([[taskSig(a), WARM_A]]) });
  assert.deepEqual(r, {
    renewed: 1, minified: 1, reowned: 1,
    idChanges: [{ from: 'c1363d8b', to: '00000001' }],
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
  assert.equal(taskSig({ ...base, id: '00000001' }), s, 'minify 改 id 不变');
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
