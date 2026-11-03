// Screen test: dragging a repo in the sidebar onto another workspace moves it there.
// Run with `npm run test:ui`.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('../helpers');
const { launchApp } = require('./app');

const sb = sandbox();
let web;
let api;
let app;

before(async () => {
  web = sb.repo('move-web');
  api = sb.repo('move-api');
  for (const r of [web, api]) {
    sb.write(r, 'a.txt', 'a\n');
    sb.sh(r, 'add', '-A');
    sb.sh(r, 'commit', '-qm', 'Base');
  }
  app = await launchApp([web, api], {}, { workspaces: [{ id: 'client', name: 'Client work', repos: [] }] });
});

after(async () => {
  await app?.close();
  sb.cleanup();
});

// Repo paths shown under each workspace in the sidebar.
const sidebar = () => app.run(`return Object.fromEntries([...document.querySelectorAll('#ws-list .ws')].map((w) =>
  [w.dataset.ws, [...w.querySelectorAll('.repo-item')].map((r) => r.dataset.repo)]));`);
const toastSays = (re) => app.waitFor(`return [...document.querySelectorAll('.toast')].some((t) => ${re}.test(t.textContent))`, `a message matching ${re}`);
// Drags a sidebar repo onto a workspace, the way the browser fires the events.
const drag = (repo, toWs, ctrlKey = false) => app.run(`
  const src = [...document.querySelectorAll('#ws-list .repo-item')].find((r) => r.dataset.repo === ${JSON.stringify(repo)});
  const dst = document.querySelector('#ws-list .ws[data-ws="${toWs}"] .ws-head');
  const dataTransfer = new DataTransfer();
  const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, ctrlKey: ${ctrlKey} }));
  fire(src, 'dragstart');
  fire(dst, 'dragover');
  const lit = !!dst.closest('.ws').classList.contains('drop-target');
  fire(dst, 'drop');
  fire(src, 'dragend');
  return lit;`);

test('drag a repo onto another workspace to move it, Ctrl to copy, with Undo', async () => {
  assert.equal(await drag(web, 'client'), true, 'the workspace lights up while dragging over it');
  await toastSays('/Moved move-web to Client work/');
  assert.deepEqual(await sidebar(), { ui: [api], client: [web] });
  assert.equal(await app.run("return state.tabs.find((t) => t.type === 'repo').ws"), 'client', 'its open tab follows it');

  await app.run("[...document.querySelectorAll('.toast')].find((t) => /Moved/.test(t.textContent)).querySelector('button').click();");
  await app.waitFor(`return document.querySelectorAll('#ws-list .ws[data-ws=ui] .repo-item').length === 2`, 'Undo to put it back');
  assert.deepEqual(await sidebar(), { ui: [web, api], client: [] });

  await drag(api, 'client', true);
  await toastSays('/Added move-api to Client work too/');
  assert.deepEqual(await sidebar(), { ui: [web, api], client: [api] });

  // Dropping onto the workspace it's already in does nothing.
  assert.equal(await drag(api, 'ui'), false);
  assert.deepEqual(await sidebar(), { ui: [web, api], client: [api] });

  // Saved: still there after a reload.
  await app.run('location.reload()');
  await app.waitFor("return document.querySelectorAll('#ws-list .ws[data-ws=client] .repo-item').length === 1", 'the sidebar after a reload', 20000);
  assert.deepEqual(await sidebar(), { ui: [web, api], client: [api] });
});
