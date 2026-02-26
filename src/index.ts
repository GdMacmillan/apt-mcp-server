#!/usr/bin/env node
import { FastMCP, UserError } from "fastmcp";
import { z } from "zod";
import { exec, spawn } from "child_process";

const server = new FastMCP({
  name: "Apt MCP Server",
  version: "0.2.0",
  instructions: `This server exposes tools for controlling the apt package manager on Linux. Tools include installing, removing, updating, and querying apt packages. All commands are executed with sudo privileges and leverage the system's apt and dpkg binaries.`
});

// Placeholder tool for server health check
server.addTool({
  name: "ping",
  description: "Check if the Apt MCP server is running.",
  parameters: z.object({}),
  execute: async () => {
    return "Apt MCP Server is running.";
  },
});

// Utility: Format tool result for consistent output
function formatToolResult({
  success,
  summary,
  stdout,
  stderr,
  logs
}: {
  success: boolean;
  summary: string;
  stdout?: string;
  stderr?: string;
  logs?: string[];
}) {
  let text = `Result: ${success ? "SUCCESS" : "ERROR"}\nSummary: ${summary}\n`;
  if (stdout) text += `\n[stdout]\n${stdout}`;
  if (stderr) text += `\n[stderr]\n${stderr}`;
  if (logs && logs.length) text += `\n[logs]\n${logs.join("\n")}`;
  return {
    content: [
      { type: "text" as const, text }
    ]
  };
}

// Timeouts per operation type (ms)
const TIMEOUTS = {
  quick: 30000,      // apt-mark, dpkg queries
  medium: 120000,    // apt update, apt install single pkg
  long: 600000,      // apt upgrade (full system, 10 min)
};

// Error classifier: returns a human-readable error category
function classifyError(stderr: string, error: Error | null, timedOut: boolean): string {
  if (timedOut) return "TIMEOUT: Operation exceeded time limit. The process may still be running in the background.";
  if (/a password is required|sudo:.*password/.test(stderr)) return "SUDO_AUTH: sudo requires a password. Run 'sudo -v' in a terminal first, or configure NOPASSWD in /etc/sudoers.d/.";
  if (/Could not get lock|is another process using it/.test(stderr)) return "LOCK: Another apt/dpkg process is running. Wait for it to finish or check with 'ps aux | grep apt'.";
  if (/Unable to locate package/.test(stderr)) return "NOT_FOUND: One or more packages could not be found.";
  if (/Packages were downgraded.*without --allow-downgrades/.test(stderr)) return "DOWNGRADE: Upgrade requires package downgrades (e.g., kernel transition). Retry with allowDowngrades: true.";
  if (/dpkg was interrupted/.test(stderr)) return "DPKG_INTERRUPTED: A previous dpkg operation was interrupted. Run 'sudo dpkg --configure -a' to fix.";
  if (/unmet dependencies|Broken packages/.test(stderr)) return "BROKEN_DEPS: Unmet dependencies detected. Try 'sudo apt --fix-broken install'.";
  if (error?.message) return `FAILED: ${error.message}`;
  if (stderr) return `FAILED: ${stderr.slice(0, 200)}`;
  return "UNKNOWN: An unknown error occurred.";
}

// Streaming spawn helper for long-running apt operations.
// Streams stdout/stderr, reports progress via callback, respects timeout.
function spawnWithProgress(
  cmd: string,
  args: string[],
  opts: {
    timeoutMs: number;
    log?: any;
    onLine?: (line: string) => void;
  }
): Promise<{ error: Error | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Give it 5s to clean up, then force kill
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, opts.timeoutMs);

    child.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      if (opts.onLine) {
        const lines = chunk.split("\n").filter((l: string) => l.trim());
        for (const line of lines) {
          opts.onLine(line);
        }
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const error = code !== 0 ? new Error(`Process exited with code ${code}`) : null;
      resolve({ error, stdout, stderr, timedOut });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ error: err, stdout, stderr, timedOut });
    });
  });
}

// Simple exec helper with timeout and error classification (for short operations)
function execSimple(cmd: string, timeoutMs: number, log?: any): Promise<{ error: Error | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    exec(cmd, { maxBuffer: 1024 * 1024, timeout: timeoutMs, env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" } }, (error, stdout, stderr) => {
      const outStr = String(stdout || '');
      const errStr = String(stderr || '');
      const timedOut = error?.killed === true;
      resolve({ error, stdout: outStr, stderr: errStr, timedOut });
    });
  });
}

// Tool: Install Apt Package(s)
server.addTool({
  name: "installAptPackage",
  description: "Install one or more apt packages using sudo.",
  parameters: z.object({
    packages: z.array(z.string().min(1).regex(/^[a-zA-Z0-9._+-]+$/, "Invalid package name")).min(1)
  }),
  execute: async (args, { log, reportProgress }) => {
    const { packages } = args;
    const pkgList = packages.join(" ");
    const totalSteps = packages.length + 1; // update + N packages

    // Step 1: sudo apt update
    reportProgress({ progress: 0, total: totalSteps });
    log.info("Running apt update");
    const updateResult = await execSimple("sudo -n apt update", TIMEOUTS.medium, log);
    if (updateResult.error) {
      const errClass = classifyError(updateResult.stderr, updateResult.error, updateResult.timedOut);
      log.error("Apt update failed", { error: errClass });
      return formatToolResult({
        success: false,
        summary: `Apt update failed: ${errClass}`,
        stdout: updateResult.stdout,
        stderr: updateResult.stderr
      });
    }
    reportProgress({ progress: 1, total: totalSteps });

    // Step 2: sudo apt install (streaming)
    log.info("Running apt install", { packages: pkgList });
    let pkgProgress = 1;
    const installResult = await spawnWithProgress("sudo", ["-n", "apt", "install", "-y", ...packages], {
      timeoutMs: TIMEOUTS.long,
      log,
      onLine: (line) => {
        if (/^(Unpacking|Setting up|Processing triggers)/.test(line)) {
          pkgProgress = Math.min(pkgProgress + 1, totalSteps - 1);
          reportProgress({ progress: pkgProgress, total: totalSteps });
          log.info(line);
        }
      }
    });

    if (installResult.error) {
      const errClass = classifyError(installResult.stderr, installResult.error, installResult.timedOut);
      log.error("Apt install failed", { error: errClass });
      return formatToolResult({
        success: false,
        summary: `Apt install failed: ${errClass}`,
        stdout: installResult.stdout,
        stderr: installResult.stderr
      });
    }
    reportProgress({ progress: totalSteps, total: totalSteps });
    return formatToolResult({
      success: true,
      summary: `Apt install succeeded for: ${pkgList}`,
      stdout: installResult.stdout,
      stderr: installResult.stderr
    });
  }
});

// Tool: Remove Apt Package(s)
server.addTool({
  name: "removeAptPackage",
  description: "Remove one or more apt packages using sudo.",
  parameters: z.object({
    packages: z.array(z.string().min(1).regex(/^[a-zA-Z0-9._+-]+$/, "Invalid package name")).min(1)
  }),
  execute: async (args, { log, reportProgress }) => {
    const { packages } = args;
    const pkgList = packages.join(" ");
    reportProgress({ progress: 0, total: 2 });
    log.info("Running apt remove", { packages: pkgList });

    let progress = 0;
    const result = await spawnWithProgress("sudo", ["-n", "apt", "remove", "-y", ...packages], {
      timeoutMs: TIMEOUTS.medium,
      log,
      onLine: (line) => {
        if (/^(Removing|Processing triggers)/.test(line)) {
          progress = Math.min(progress + 1, 1);
          reportProgress({ progress, total: 2 });
          log.info(line);
        }
      }
    });

    if (result.error) {
      const errClass = classifyError(result.stderr, result.error, result.timedOut);
      log.error("Apt remove failed", { error: errClass });
      return formatToolResult({
        success: false,
        summary: `Apt remove failed: ${errClass}`,
        stdout: result.stdout,
        stderr: result.stderr
      });
    }
    reportProgress({ progress: 2, total: 2 });
    return formatToolResult({
      success: true,
      summary: `Apt remove succeeded for: ${pkgList}`,
      stdout: result.stdout,
      stderr: result.stderr
    });
  }
});

// Tool: Query Apt Package Status
server.addTool({
  name: "queryAptPackageStatus",
  description: "Query if a package is installed, available, or upgradable.",
  parameters: z.object({
    package: z.string().min(1).regex(/^[a-zA-Z0-9._+-]+$/, "Invalid package name")
  }),
  execute: async (args, { log }) => {
    const { package: pkg } = args;
    const checkInstalled = () => new Promise<string>((resolve) => {
      exec(`dpkg -l ${pkg}`, { timeout: TIMEOUTS.quick }, (error, stdout) => {
        if (error) return resolve("not installed");
        resolve(stdout.includes(pkg) ? "installed" : "not installed");
      });
    });
    const checkUpgradable = () => new Promise<string>((resolve) => {
      exec(`apt list --upgradable 2>/dev/null | grep ^${pkg}/`, { timeout: TIMEOUTS.quick }, (error, stdout) => {
        resolve(stdout && stdout.includes(pkg) ? "upgradable" : "");
      });
    });
    const checkAvailable = () => new Promise<string>((resolve) => {
      exec(`apt-cache show ${pkg}`, { timeout: TIMEOUTS.quick }, (error, stdout) => {
        resolve(stdout && stdout.includes("Package:") ? "available" : "not available");
      });
    });
    log.info("Querying package status", { pkg });
    try {
      const [installed, upgradable, available] = await Promise.all([
        checkInstalled(), checkUpgradable(), checkAvailable()
      ]);
      let status = `Package: ${pkg}\nInstalled: ${installed}\n`;
      if (upgradable) status += `Upgradable: yes\n`;
      status += `Available: ${available}`;
      return formatToolResult({
        success: true,
        summary: `Status for package ${pkg}: Installed=${installed}, Upgradable=${!!upgradable}, Available=${available}`,
        stdout: status
      });
    } catch (e: any) {
      log.error("Query package status failed", { error: e.message });
      return formatToolResult({ success: false, summary: `Failed to query package status: ${e.message}` });
    }
  }
});

// Tool: Update Apt Packages
server.addTool({
  name: "updateAptPackages",
  description: "Update the apt package list and upgrade all packages using sudo.",
  parameters: z.object({
    allowDowngrades: z.boolean().optional().describe("Allow package downgrades during upgrade (e.g., when kernel transitions require it). Default: false.")
  }),
  execute: async (args, { log, reportProgress }) => {
    const { allowDowngrades } = args;

    // Phase 1: apt update (streaming)
    reportProgress({ progress: 0, total: 100 });
    log.info("Phase 1/2: Updating package lists...");
    const updateResult = await spawnWithProgress("sudo", ["-n", "apt", "update"], {
      timeoutMs: TIMEOUTS.medium,
      log,
      onLine: (line) => {
        if (/^(Get|Hit|Ign):/.test(line)) {
          log.info(line);
        }
      }
    });

    if (updateResult.error) {
      const errClass = classifyError(updateResult.stderr, updateResult.error, updateResult.timedOut);
      log.error("Apt update failed", { error: errClass });
      return formatToolResult({
        success: false,
        summary: `Apt update failed: ${errClass}`,
        stdout: updateResult.stdout,
        stderr: updateResult.stderr
      });
    }
    reportProgress({ progress: 10, total: 100 });
    log.info("Phase 1/2 complete: Package lists updated.");

    // Phase 2: apt upgrade (streaming with progress)
    const upgradeArgs = ["-n", "apt", "upgrade", "-y"];
    if (allowDowngrades) upgradeArgs.push("--allow-downgrades");

    log.info("Phase 2/2: Upgrading packages...");
    let upgradedCount = 0;
    let currentAction = "";

    const upgradeResult = await spawnWithProgress("sudo", upgradeArgs, {
      timeoutMs: TIMEOUTS.long,
      log,
      onLine: (line) => {
        // Track download progress
        if (/^Get:\d+/.test(line)) {
          upgradedCount++;
          // Scale downloads to 10-50% range
          const pct = Math.min(10 + Math.floor(upgradedCount * 0.5), 50);
          reportProgress({ progress: pct, total: 100 });
          log.info(line);
        }
        // Track unpacking/setup progress
        else if (/^Unpacking /.test(line)) {
          currentAction = line;
          const pct = Math.min(50 + Math.floor(upgradedCount * 0.3), 80);
          reportProgress({ progress: pct, total: 100 });
          log.info(line);
        }
        else if (/^Setting up /.test(line)) {
          currentAction = line;
          const pct = Math.min(80 + Math.floor(upgradedCount * 0.1), 95);
          reportProgress({ progress: pct, total: 100 });
          log.info(line);
        }
        else if (/^Processing triggers/.test(line)) {
          reportProgress({ progress: 96, total: 100 });
          log.info(line);
        }
        // Log kept-back packages (held)
        else if (/kept back/.test(line) || /The following packages have been kept back/.test(line)) {
          log.info(line);
        }
      }
    });

    if (upgradeResult.error) {
      const errClass = classifyError(upgradeResult.stderr, upgradeResult.error, upgradeResult.timedOut);
      log.error("Apt upgrade failed", { error: errClass });
      return formatToolResult({
        success: false,
        summary: `Apt upgrade failed: ${errClass}`,
        stdout: upgradeResult.stdout,
        stderr: upgradeResult.stderr
      });
    }

    reportProgress({ progress: 100, total: 100 });
    log.info("Phase 2/2 complete: All packages upgraded.");
    return formatToolResult({
      success: true,
      summary: "Apt update and upgrade completed successfully.",
      stdout: upgradeResult.stdout,
      stderr: [updateResult.stderr, upgradeResult.stderr].filter(Boolean).join("\n")
    });
  }
});

// Tool: List Upgradable Apt Packages
server.addTool({
  name: "listUpgradableAptPackages",
  description: "List all upgradable apt packages.",
  parameters: z.object({}),
  execute: async (_args, { log }) => {
    log.info("Listing upgradable apt packages");
    const result = await execSimple("apt list --upgradable 2>/dev/null", TIMEOUTS.quick, log);
    if (result.error) {
      const errClass = classifyError(result.stderr, result.error, result.timedOut);
      return formatToolResult({
        success: false,
        summary: `Listing upgradable packages failed: ${errClass}`,
        stdout: result.stdout,
        stderr: result.stderr
      });
    }
    return formatToolResult({
      success: true,
      summary: "Listed upgradable packages successfully.",
      stdout: result.stdout,
      stderr: result.stderr
    });
  }
});

// Tool: Upgrade Specific Apt Package
server.addTool({
  name: "upgradeSpecificAptPackage",
  description: "Upgrade a specific apt package using sudo.",
  parameters: z.object({
    package: z.string().min(1).regex(/^[a-zA-Z0-9._+-]+$/, "Invalid package name")
  }),
  execute: async (args, { log, reportProgress }) => {
    const { package: pkg } = args;
    reportProgress({ progress: 0, total: 3 });
    log.info("Running apt install --only-upgrade", { package: pkg });

    let progress = 0;
    const result = await spawnWithProgress("sudo", ["-n", "apt", "install", "--only-upgrade", "-y", pkg], {
      timeoutMs: TIMEOUTS.medium,
      log,
      onLine: (line) => {
        if (/^(Unpacking|Setting up|Processing triggers)/.test(line)) {
          progress = Math.min(progress + 1, 2);
          reportProgress({ progress, total: 3 });
          log.info(line);
        }
      }
    });

    if (result.error) {
      const errClass = classifyError(result.stderr, result.error, result.timedOut);
      log.error("Apt only-upgrade failed", { error: errClass });
      return formatToolResult({
        success: false,
        summary: `Apt only-upgrade failed: ${errClass}`,
        stdout: result.stdout,
        stderr: result.stderr
      });
    }
    reportProgress({ progress: 3, total: 3 });
    return formatToolResult({
      success: true,
      summary: `Apt only-upgrade succeeded for: ${pkg}`,
      stdout: result.stdout,
      stderr: result.stderr
    });
  }
});

// Tool: Hold Apt Package(s)
server.addTool({
  name: "holdAptPackage",
  description: "Hold one or more apt packages to prevent them from being upgraded.",
  parameters: z.object({
    packages: z.array(z.string().min(1).regex(/^[a-zA-Z0-9._+-]+$/, "Invalid package name")).min(1)
  }),
  execute: async (args, { log }) => {
    const { packages } = args;
    const pkgList = packages.join(" ");
    const cmd = `sudo -n apt-mark hold ${pkgList}`;
    log.info("Running apt-mark hold", { cmd });
    const result = await execSimple(cmd, TIMEOUTS.quick, log);
    if (result.error) {
      const errClass = classifyError(result.stderr, result.error, result.timedOut);
      log.error("Apt-mark hold failed", { error: errClass });
      return formatToolResult({
        success: false,
        summary: `Apt-mark hold failed: ${errClass}`,
        stdout: result.stdout,
        stderr: result.stderr
      });
    }
    return formatToolResult({
      success: true,
      summary: `Apt-mark hold succeeded for: ${pkgList}`,
      stdout: result.stdout,
      stderr: result.stderr
    });
  }
});

// Tool: Unhold Apt Package(s)
server.addTool({
  name: "unholdAptPackage",
  description: "Unhold one or more apt packages to allow them to be upgraded again.",
  parameters: z.object({
    packages: z.array(z.string().min(1).regex(/^[a-zA-Z0-9._+-]+$/, "Invalid package name")).min(1)
  }),
  execute: async (args, { log }) => {
    const { packages } = args;
    const pkgList = packages.join(" ");
    const cmd = `sudo -n apt-mark unhold ${pkgList}`;
    log.info("Running apt-mark unhold", { cmd });
    const result = await execSimple(cmd, TIMEOUTS.quick, log);
    if (result.error) {
      const errClass = classifyError(result.stderr, result.error, result.timedOut);
      log.error("Apt-mark unhold failed", { error: errClass });
      return formatToolResult({
        success: false,
        summary: `Apt-mark unhold failed: ${errClass}`,
        stdout: result.stdout,
        stderr: result.stderr
      });
    }
    return formatToolResult({
      success: true,
      summary: `Apt-mark unhold succeeded for: ${pkgList}`,
      stdout: result.stdout,
      stderr: result.stderr
    });
  }
});

// Tool: Autoremove Apt Packages
server.addTool({
  name: "autoremoveAptPackages",
  description: "Remove packages that were automatically installed to satisfy dependencies for other packages and are now no longer needed.",
  parameters: z.object({}),
  execute: async (_args, { log, reportProgress }) => {
    reportProgress({ progress: 0, total: 2 });
    log.info("Running apt autoremove");
    let progress = 0;
    const result = await spawnWithProgress("sudo", ["-n", "apt", "autoremove", "-y"], {
      timeoutMs: TIMEOUTS.medium,
      log,
      onLine: (line) => {
        if (/^(Removing|Processing triggers)/.test(line)) {
          progress = Math.min(progress + 1, 1);
          reportProgress({ progress, total: 2 });
          log.info(line);
        }
      }
    });

    if (result.error) {
      const errClass = classifyError(result.stderr, result.error, result.timedOut);
      log.error("Apt autoremove failed", { error: errClass });
      return formatToolResult({
        success: false,
        summary: `Apt autoremove failed: ${errClass}`,
        stdout: result.stdout,
        stderr: result.stderr
      });
    }
    reportProgress({ progress: 2, total: 2 });
    return formatToolResult({
      success: true,
      summary: "Apt autoremove completed successfully.",
      stdout: result.stdout,
      stderr: result.stderr
    });
  }
});

server.start({
  transportType: "stdio",
});

export { formatToolResult };
