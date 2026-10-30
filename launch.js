// Starts the app with Electron. Terminals inside VS Code/Cursor can leak
// ELECTRON_RUN_AS_NODE, which would make Electron behave like plain Node.
const { spawn } = require('child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [__dirname, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: false });
child.on('exit', (code) => process.exit(code ?? 0));
