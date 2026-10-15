// Loaded before every test file (package.json "test"): records the engine writes under the
// kit home (index, usage) go to a temporary directory, never the machine's own ~/.req-kit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.REQ_KIT_HOME) process.env.REQ_KIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-test-home-"));
