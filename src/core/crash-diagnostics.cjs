'use strict';
const fs = require('node:fs');
const path = require('node:path');

function StartCrashDiagnostics({ app, crashReporter, installRoot, runId }) {
  const directory = installRoot ? path.join(installRoot, 'runtime', 'logs') : app.getPath('userData');
  const crashDumps = path.join(directory, 'crashes'), logFile = path.join(directory, 'electron.log');
  let started = false, error = null;
  try {
    fs.mkdirSync(crashDumps, { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 4 * 1024 * 1024) {
      fs.rmSync(`${logFile}.old`, { force: true }); fs.renameSync(logFile, `${logFile}.old`);
    }
    app.commandLine.appendSwitch('enable-logging', 'file');
    app.commandLine.appendSwitch('log-file', logFile);
    app.commandLine.appendSwitch('log-level', '1');
    app.setPath('crashDumps', crashDumps);
    // 画面を作る前に接続し、ネイティブ障害も端末内だけに記録する。
    crashReporter.start({ productName: 'Favecus Player', uploadToServer: false,
      globalExtra: { favecus_run: String(runId || 'direct').slice(0, 127), favecus_version: app.getVersion() } });
    started = true;
  } catch (cause) { error = String(cause.message).slice(0, 240); }
  return { directory, crashDumps, logFile, started, error,
    Annotate(values) {
      if (!started) return;
      try { for (const [key, value] of Object.entries(values)) crashReporter.addExtraParameter(`favecus_${key}`, String(value ?? '').slice(0, 127)); } catch {}
    }
  };
}
module.exports = { StartCrashDiagnostics };
