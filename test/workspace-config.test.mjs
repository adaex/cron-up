import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  readWorkspaceConfig, configuredModel, maintainWorkspace,
} from '../src/tasks.mjs';
import { WORKSPACE_CONFIG_REL } from '../src/paths.mjs';
import {
  mkTmp, writeJson, readJson, writeTaskFile, makeTask,
} from '../test-support/helpers.mjs';

function setup(t) {
  const ws = path.join(mkTmp(t), 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const file = path.join(ws, WORKSPACE_CONFIG_REL);
  return { ws, file };
}

test('missing workspace config preserves the Claude Code default', (t) => {
  const s = setup(t);
  const cfg = readWorkspaceConfig(s.ws);
  assert.equal(cfg.error, null);
  assert.equal(configuredModel(cfg, '00000001'), undefined);
});

test('task model overrides the workspace default and values are trimmed', (t) => {
  const s = setup(t);
  writeJson(s.file, {
    model: ' claude-opus-5-5 ',
    tasks: {
      '00000001': { model: ' sonnet ' },
      '00000002': {},
    },
    futureField: true,
  });
  const cfg = readWorkspaceConfig(s.ws);
  assert.equal(cfg.error, null);
  assert.equal(configuredModel(cfg, '00000001'), 'sonnet');
  assert.equal(configuredModel(cfg, '00000002'), 'claude-opus-5-5');
  assert.equal(configuredModel(cfg, 'missing'), 'claude-opus-5-5');
});

test('special task keys are read as own properties', (t) => {
  const s = setup(t);
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.writeFileSync(s.file, '{"model":"claude-opus-5-5","tasks":'
    + '{"__proto__":{"model":"sonnet"}}}');
  const cfg = readWorkspaceConfig(s.ws);
  assert.equal(cfg.error, null);
  assert.equal(configuredModel(cfg, '__proto__'), 'sonnet');
  assert.equal(configuredModel(cfg, 'toString'), 'claude-opus-5-5');
});

test('invalid model fields reject the whole workspace config', (t) => {
  const s = setup(t);
  const invalid = [
    [],
    { model: '' },
    { model: 42 },
    { tasks: [] },
    { tasks: { '00000001': 'sonnet' } },
    { tasks: { '00000001': { model: false } } },
  ];
  for (const doc of invalid) {
    writeJson(s.file, doc);
    const cfg = readWorkspaceConfig(s.ws);
    assert.equal(cfg.config, null, JSON.stringify(doc));
    assert.ok(cfg.error.includes(s.file), JSON.stringify(doc));
    assert.equal(configuredModel(cfg, '00000001'), undefined);
  }
});

test('task model override follows an automatically minimized task id', (t) => {
  const s = setup(t);
  writeJson(s.file, {
    tasks: { '554e2879': { model: 'sonnet' } },
    futureField: true,
  });
  const taskfile = writeTaskFile(s.ws, [
    makeTask({ id: '554e2879', cron: '0 5 * * *' }),
  ]);
  const r = maintainWorkspace(taskfile);
  assert.equal(r.minified, 1);
  assert.equal(r.modelAliases, 1);
  const cfg = readWorkspaceConfig(s.ws);
  assert.equal(cfg.error, null);
  assert.equal(configuredModel(cfg, '00000001'), 'sonnet');
  assert.equal(configuredModel(cfg, '554e2879'), 'sonnet', '旧键保留为兼容别名');
  assert.equal(readJson(s.file).futureField, true);
});

test('automatic id allocation does not reuse a configured key from another task', (t) => {
  const s = setup(t);
  writeJson(s.file, {
    model: 'default-model',
    tasks: {
      '00000001': { model: 'old-task-model' },
      '554e2879': { model: 'sonnet' },
    },
  });
  const taskfile = writeTaskFile(s.ws, [
    makeTask({ id: '554e2879', cron: '0 5 * * *' }),
  ]);
  const r = maintainWorkspace(taskfile);
  assert.deepEqual(r.idChanges, [{ from: '554e2879', to: '00000002' }]);
  const cfg = readWorkspaceConfig(s.ws);
  assert.equal(configuredModel(cfg, '00000002'), 'sonnet');
  assert.equal(configuredModel(cfg, '00000001'), 'old-task-model',
    '旧任务留下的配置不能被新任务继承');
});

test('invalid workspace config postpones id minification instead of losing the override', (t) => {
  const s = setup(t);
  writeJson(s.file, { tasks: { '554e2879': { model: false } } });
  const taskfile = writeTaskFile(s.ws, [
    makeTask({ id: '554e2879', cron: '0 5 * * *' }),
  ]);
  const r = maintainWorkspace(taskfile);
  assert.equal(r.minified, 0);
  assert.deepEqual(r.idChanges, []);
  assert.equal(readJson(taskfile).tasks[0].id, '554e2879');
  assert.equal(readJson(taskfile).tasks[0].permanent, true, '续期不受改号暂缓影响');
});

test('malformed JSON is an explicit config error', (t) => {
  const s = setup(t);
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.writeFileSync(s.file, '{ not json');
  const cfg = readWorkspaceConfig(s.ws);
  assert.equal(cfg.config, null);
  assert.ok(cfg.error.includes('不是合法 JSON'));
});
