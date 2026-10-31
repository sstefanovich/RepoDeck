// Throwaway git repos for tests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repodeck-test-'));
  const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  const write = (repo, file, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  };
  const repo = (name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    sh(dir, 'init', '-q', '-b', 'main');
    sh(dir, 'config', 'user.name', 'Test');
    sh(dir, 'config', 'user.email', 'test@example.com');
    return dir;
  };
  const server = (name) => {
    const dir = path.join(root, `${name}.git`);
    sh(root, 'init', '-q', '--bare', '-b', 'main', dir);
    return dir;
  };
  const clone = (from, name) => {
    const dir = path.join(root, name);
    sh(root, 'clone', '-q', from, dir);
    sh(dir, 'config', 'user.name', 'Other');
    sh(dir, 'config', 'user.email', 'other@example.com');
    return dir;
  };
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { root, sh, write, repo, server, clone, cleanup };
}

module.exports = { sandbox };
