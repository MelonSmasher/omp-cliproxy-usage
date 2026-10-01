// Loaded before any test module: point omp at a throwaway config root and
// agent dir so the pinned omp packages (which resolve their directories at
// import time) never read or write the developer's real configuration.
// Bun's os.homedir() ignores runtime HOME changes, so the config root is
// redirected with a PI_CONFIG_DIR relative to the real home.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cliproxy-usage-home-"));
const configRoot = path.join(root, ".omp");
process.env.HOME = root;
process.env.PI_CONFIG_DIR = path.relative(os.homedir(), configRoot);
process.env.PI_CODING_AGENT_DIR = path.join(configRoot, "agent");
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
for (const key of ["PI_PROFILE", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) {
	delete process.env[key];
}
