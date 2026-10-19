// Loaded before every test file (package.json "test"): records the engine writes under the
// kit home (index, usage) go to a temporary directory, never the machine's own ~/.req-kit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Windows: the temporary directory is often given in its short 8.3 form (C:\Users\RUNNER~1\…),
// while the engine records real paths (C:\Users\runneradmin\…). Tests compare the two, so
// they start from the real one.
if (process.platform === "win32") {
  try {
    const real = fs.realpathSync.native(os.tmpdir());
    process.env.TEMP = real;
    process.env.TMP = real;
  } catch {
    // Keep the system's.
  }
}

if (!process.env.REQ_KIT_HOME) process.env.REQ_KIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-test-home-"));
