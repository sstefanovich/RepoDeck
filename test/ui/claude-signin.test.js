// Screen test: when Claude Code's login has expired, the ✦ features and the panel say so and offer to sign in again.
// Run with `npm run test:ui`.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('../helpers');
const { launchApp, LAYOUT_PROBLEMS } = require('./app');

const sb = sandbox();
let app;

before(async () => {
  const repo = sb.repo('claude-signin');
  sb.write(repo, 'a.txt', 'a\n');
  sb.sh(repo, 'add', '-A');
  sb.sh(repo, 'commit', '-qm', 'First');
  app = await launchApp([repo]);
});

after(async () => {
  await app?.close();
  sb.cleanup();
});

const modalTitle = () => app.run("return document.querySelector('.modal h2')?.textContent || ''");
const closeModal = () => app.run("document.querySelector('.modal [data-close=cancel], .modal [data-close=ok]')?.click();");

test('an expired login gets the sign-in dialog; other errors the usual one', async () => {
  app.run("showClaudeError(\"Claude couldn't write a message\", new Error('OAuth token has expired. Please obtain a new token or refresh your existing token.'));");
  await app.waitFor("return document.querySelector('.modal')", 'the dialog');
  assert.equal(await modalTitle(), 'Claude needs you to sign in again');
  assert.ok(await app.run("return !!document.querySelector('.modal [data-close=login]')"), 'offers to open Claude');
  assert.deepEqual(await app.run(LAYOUT_PROBLEMS), [], 'the dialog fits');
  if (process.env.SHOTS) await app.screenshot('claude sign in');
  await closeModal();
  await app.waitFor("return !document.querySelector('.modal')", 'the dialog to close');

  app.run("showClaudeError(\"Claude couldn't write a message\", new Error('Claude took too long to answer.'));");
  await app.waitFor("return document.querySelector('.modal')", 'the dialog');
  assert.equal(await modalTitle(), "Claude couldn't write a message");
  await closeModal();
});

test('in the panel, a login error shows a sign-in button instead of the raw message', async () => {
  await app.run(`toggleClaude(true);
    cl.running = true;
    onClaudeEvent({ type: 'result', key: cl.id, isError: true, subtype: 'success', text: 'Invalid API key · Please run /login' });`);
  await app.waitFor("return document.querySelector('#cp-msgs [data-action=claude-login]')", 'the sign-in button');
  assert.match(await app.run("return document.querySelector('#cp-msgs .cp-notice').textContent"), /needs you to sign in again/);
  if (process.env.SHOTS) await app.screenshot('claude sign in panel');
});
