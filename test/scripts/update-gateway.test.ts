import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linkPnpmBootstrapShellTools } from "./test-helpers.js";

describe("source-server updater bootstrap", () => {
  it.each([
    "success",
    "missing",
    "enable-failure",
    "install-failure",
    "build-failure",
    "dirty",
    "symlink",
    "rebase-failure",
  ])("keeps checkout and restart boundaries for %s", (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-server-bootstrap-"));
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const temp = join(root, "temp");
    for (const dir of [join(repo, "scripts"), join(repo, ".git"), bin, temp])
      mkdirSync(dir, { recursive: true });
    linkPnpmBootstrapShellTools(bin);
    const script = join(repo, "scripts/update-gateway.sh");
    writeFileSync(script, readFileSync("scripts/update-gateway.sh"));
    writeFileSync(join(repo, "package.json"), '{"packageManager":"pnpm@11.15.1"}');
    writeFileSync(join(repo, "pnpm-lock.yaml"), "untouched\n");
    const executable = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    executable(
      "git",
      `
      case "$*" in
        'rev-parse --git-dir') echo .git ;;
        'diff --quiet') [[ "$SCENARIO" != dirty ]] ;;
        'diff --cached --quiet'|'ls-files --others --exclude-standard') exit 0 ;;
        'status --short') echo ' M package.json' ;;
        'rev-parse --abbrev-ref HEAD') echo server ;;
        'rev-parse --short HEAD') echo abc123 ;;
        *)
          echo "$*" >> "$FIXTURE/git-mutations"
          [[ "$SCENARIO" != rebase-failure || "$1" != rebase || "$2" == --abort ]] || exit 1
          if [[ "$1" == rebase && "$2" != --abort ]]; then echo '{"packageManager":"pnpm@12.0.0"}' > package.json; fi
          ;;
      esac
    `,
    );
    executable("pnpm", 'echo ambient >> "$FIXTURE/steps"; exit 93');
    executable(
      "selected",
      `
      [[ "\${COREPACK_ENABLE_DOWNLOAD_PROMPT:-}" == 0 ]] || { echo "Corepack would await terminal input" >&2; exit 91; }
      [[ -z "\${CI:-}" ]]
      [[ "$PWD" == "$TARGET" ]]
      [[ "$NPM_CONFIG_WORKSPACE_DIR" == "$TARGET" && "$npm_config_workspace_dir" == "$TARGET" ]]
      [[ "$PNPM_CONFIG_LOCKFILE_DIR" == "$TARGET" && "$pnpm_config_lockfile_dir" == "$TARGET" ]]
      grep -q 'pnpm@12.0.0' package.json
      case "$1" in
        install) [[ "$2" == --frozen-lockfile ]]; echo install >> "$FIXTURE/steps"; [[ "$SCENARIO" != install-failure ]] || exit 42 ;;
        build) echo build >> "$FIXTURE/steps"; pnpm nested ;;
        nested) [[ "$SCENARIO" != build-failure ]] || exit 42; echo nested >> "$FIXTURE/steps" ;;
        *) exit 94 ;;
      esac
    `,
    );
    if (scenario !== "missing")
      executable(
        "corepack",
        `
      [[ "$1 $2" == 'enable --install-directory' && "$4" == pnpm ]]
      [[ "$3" == "$FIXTURE/"* ]]
      [[ "$SCENARIO" != enable-failure ]] || exit 1
      cp "$FIXTURE/bin/selected" "$3/pnpm"
    `,
      );
    if (scenario === "symlink") symlinkSync(root, join(repo, "dist"));
    try {
      const result = spawnSync("/bin/bash", [script], {
        encoding: "utf8",
        env: {
          PATH: bin,
          COREPACK_ENABLE_DOWNLOAD_PROMPT: "1",
          HOME: root,
          TMPDIR: temp,
          FIXTURE: root,
          TARGET: repo,
          SCENARIO: scenario,
          NPM_CONFIG_WORKSPACE_DIR: root,
          npm_config_workspace_dir: root,
          PNPM_CONFIG_LOCKFILE_DIR: root,
          pnpm_config_lockfile_dir: root,
          OPENCLAW_UPDATE_RESTART_CMD:
            '[[ "$COREPACK_ENABLE_DOWNLOAD_PROMPT" == 1 ]] && echo restart >> "$FIXTURE/steps"',
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(
        scenario === "success"
          ? 0
          : scenario.endsWith("-failure") && ["install-failure", "build-failure"].includes(scenario)
            ? 42
            : 1,
      );
      const steps = existsSync(join(root, "steps"))
        ? readFileSync(join(root, "steps"), "utf8").trim().split("\n")
        : [];
      expect(steps).toEqual(
        scenario === "success"
          ? ["install", "build", "nested", "restart"]
          : scenario === "build-failure"
            ? ["install", "build"]
            : ["install-failure", "symlink"].includes(scenario)
              ? ["install"]
              : [],
      );
      if (["missing", "enable-failure", "dirty"].includes(scenario))
        expect(existsSync(join(root, "git-mutations"))).toBe(false);
      if (scenario === "missing" || scenario === "enable-failure")
        expect(result.stdout + result.stderr).toContain("Corepack");
      if (scenario === "rebase-failure")
        expect(readFileSync(join(root, "git-mutations"), "utf8")).toContain("rebase --abort");
      expect(readFileSync(join(repo, "pnpm-lock.yaml"), "utf8")).toBe("untouched\n");
      expect(readdirSync(temp)).toEqual([]);
      expect(result.stdout.includes("OK abc123")).toBe(scenario === "success");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
