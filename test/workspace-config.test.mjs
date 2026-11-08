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
  assert.equal(configuredModel(cfg), undefined);
});

test('workspace default model is trimmed and unknown future fields are ignored', (t) => {
  const s = setup(t);
  writeJson(s.file, { model: ' claude-opus-5-5 ', futureField: true });
  const cfg = readWorkspaceConfig(s.ws);
  assert.equal(cfg.error, null);
  assert.equal(configuredModel(cfg), 'claude-opus-5-5');
});

test('legacy per-task model overrides are an explicit config error', (t) => {
  const s = setup(t);
  writeJson(s.file, {
    model: 'claude-opus-5-5',
    tasks: { '00000001': { model: 'sonnet' } },
  });
  const cfg = readWorkspaceConfig(s.ws);
  assert.equal(cfg.config, null);
  assert.ok(cfg.error.includes('不再支持 tasks'));
  assert.ok(cfg.error.includes('只保留顶层 model'));
  assert.equal(configuredModel(cfg), undefined);
});

test('invalid default model fields reject the whole workspace config', (t) => {
  const s = setup(t);
  for (const doc of [[], { model: '' }, { model: 42 }]) {
    writeJson(s.file, doc);
    const cfg = readWorkspaceConfig(s.ws);
    assert.equal(cfg.config, null, JSON.stringify(doc));
    assert.ok(cfg.error.includes(s.file), JSON.stringify(doc));
    assert.equal(configuredModel(cfg), undefined);
  }
});

test('invalid workspace model does not block automatic task maintenance', (t) => {
  const s = setup(t);
  writeJson(s.file, { model: '' });
  const before = fs.readFileSync(s.file, 'utf-8');
  const taskfile = writeTaskFile(s.ws, [
    makeTask({ id: '554e2879', cron: '0 5 * * *', permanent: false }),
  ]);
  const r = maintainWorkspace(taskfile);
  assert.equal(r.renewed, 1);
  assert.equal(r.minified, 1);
  assert.deepEqual(r.idChanges, [{ from: '554e2879', to: '00000001' }]);
  assert.equal(readJson(taskfile).tasks[0].permanent, true);
  assert.equal(fs.readFileSync(s.file, 'utf-8'), before, '巡检不改写工作区模型配置');
});

test('malformed JSON is an explicit config error', (t) => {
  const s = setup(t);
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.writeFileSync(s.file, '{ not json');
  const cfg = readWorkspaceConfig(s.ws);
  assert.equal(cfg.config, null);
  assert.ok(cfg.error.includes('不是合法 JSON'));
});
