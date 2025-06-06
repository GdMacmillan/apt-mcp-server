#!/usr/bin/env node
import { FastMCP, UserError } from "fastmcp";
import { z } from "zod";
import { exec } from "child_process";

const server = new FastMCP({
  name: "Apt MCP Server",
  version: "0.1.0",
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

// Helper: Retry exec for transient errors (e.g., apt lock)
function execWithRetry(cmd: string, opts: any = {}, retries = 1, delayMs = 1000, log?: any) {
  return new Promise<{ error: Error | null; stdout: string; stderr: string }>((resolve) => {
    exec(cmd, opts, (error, stdout, stderr) => {
      // Ensure stdout/stderr are strings (handle Buffer case)
      const outStr = typeof stdout === 'string' ? stdout : stdout?.toString() || '';
      const errStr = typeof stderr === 'string' ? stderr : stderr?.toString() || '';
      if (error && errStr && /Could not get lock|is another process using it/.test(errStr) && retries > 0) {
        if (log) log.warn("Transient error detected, retrying...", { cmd, stderr: errStr });
        setTimeout(() => {
          exec(cmd, opts, (error2, stdout2, stderr2) => {
            const outStr2 = typeof stdout2 === 'string' ? stdout2 : stdout2?.toString() || '';
            const errStr2 = typeof stderr2 === 'string' ? stderr2 : stderr2?.toString() || '';
            resolve({ error: error2, stdout: outStr2, stderr: errStr2 });
          });
        }, delayMs);
      } else {
        resolve({ error, stdout: outStr, stderr: errStr });
      }
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
  execute: async (args, { log }) => {
    const { packages } = args;
    const pkgList = packages.join(" ");
    // Step 1: sudo apt update
    log.info("Running apt update");
    const updateResult = await new Promise<{ success: boolean; stdout: string; stderr: string }>((resolve) => {
      exec("sudo apt update", { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          log.error("Apt update failed", { error: error.message, stderr });
          resolve({ success: false, stdout, stderr });
        } else {
          log.info("Apt update succeeded", { stdout });
          resolve({ success: true, stdout, stderr });
        }
      });
    });
    if (!updateResult.success) {
      return formatToolResult({
        success: false,
        summary: "Apt update failed before install.",
        stdout: updateResult.stdout,
        stderr: updateResult.stderr
      });
    }
    // Step 2: sudo apt install
    const cmd = `sudo apt install -y ${pkgList}`;
    log.info("Running apt install", { cmd });
    return new Promise((resolve) => {
      exec(cmd, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          log.error("Apt install failed", { error: error.message, stderr });
          resolve(formatToolResult({
            success: false,
            summary: `Apt install failed: ${stderr || error.message}`,
            stdout,
            stderr
          }));
        } else {
          log.info("Apt install succeeded", { stdout });
          resolve(formatToolResult({
            success: true,
            summary: `Apt install succeeded for: ${pkgList}`,
            stdout,
            stderr
          }));
        }
      });
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
  execute: async (args, { log }) => {
    const { packages } = args;
    const pkgList = packages.join(" ");
    const cmd = `sudo apt remove -y ${pkgList}`;
    log.info("Running apt remove", { cmd });
    const { error, stdout, stderr } = await execWithRetry(cmd, { maxBuffer: 1024 * 1024 }, 1, 1000, log);
    if (error) {
      log.error("Apt remove failed", { error: error.message, stderr });
      return formatToolResult({
        success: false,
        summary: `Apt remove failed: ${stderr || error.message}`,
        stdout,
        stderr
      });
    } else {
      log.info("Apt remove succeeded", { stdout });
      return formatToolResult({
        success: true,
        summary: `Apt remove succeeded for: ${pkgList}`,
        stdout,
        stderr
      });
    }
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
    // Check installed status
    const checkInstalled = () => new Promise<string>((resolve) => {
      exec(`dpkg -l ${pkg}`, (error, stdout, stderr) => {
        if (error) return resolve("not installed");
        if (stdout.includes(pkg)) {
          resolve("installed");
        } else {
          resolve("not installed");
        }
      });
    });
    // Check upgradable status
    const checkUpgradable = () => new Promise<string>((resolve) => {
      exec(`apt list --upgradable 2>/dev/null | grep ^${pkg}/`, (error, stdout) => {
        if (stdout && stdout.includes(pkg)) {
          resolve("upgradable");
        } else {
          resolve("");
        }
      });
    });
    // Check available status
    const checkAvailable = () => new Promise<string>((resolve) => {
      exec(`apt-cache show ${pkg}`, (error, stdout) => {
        if (stdout && stdout.includes("Package:")) {
          resolve("available");
        } else {
          resolve("not available");
        }
      });
    });
    log.info("Querying package status", { pkg });
    try {
      const [installed, upgradable, available] = await Promise.all([
        checkInstalled(),
        checkUpgradable(),
        checkAvailable()
      ]);
      let status = `Package: ${pkg}\n`;
      status += `Installed: ${installed}\n`;
      if (upgradable) status += `Upgradable: yes\n`;
      status += `Available: ${available}`;
      return formatToolResult({
        success: true,
        summary: `Status for package ${pkg}: Installed=${installed}, Upgradable=${!!upgradable}, Available=${available}`,
        stdout: status
      });
    } catch (e: any) {
      log.error("Query package status failed", { error: e.message });
      return formatToolResult({
        success: false,
        summary: `Failed to query package status: ${e.message}`
      });
    }
  }
});

// Tool: Update Apt Packages
server.addTool({
  name: "updateAptPackages",
  description: "Update the apt package list and upgrade all packages using sudo.",
  parameters: z.object({}),
  execute: async (_args, { log, reportProgress }) => {
    reportProgress({ progress: 0, total: 3 });
    log.info("Running apt update");
    const updateResult = await execWithRetry("sudo apt update", { maxBuffer: 1024 * 1024 }, 1, 1000, log);
    if (updateResult.error) {
      reportProgress({ progress: 1, total: 3 });
      log.error("Apt update failed", { error: updateResult.error.message, stderr: updateResult.stderr });
      return formatToolResult({
        success: false,
        summary: `Apt update failed: ${updateResult.stderr || updateResult.error.message}`,
        stdout: updateResult.stdout,
        stderr: updateResult.stderr
      });
    }
    reportProgress({ progress: 1, total: 3 });
    log.info("Running apt upgrade");
    const upgradeResult = await execWithRetry("sudo apt upgrade -y", { maxBuffer: 1024 * 1024 }, 1, 1000, log);
    if (upgradeResult.error) {
      reportProgress({ progress: 2, total: 3 });
      log.error("Apt upgrade failed", { error: upgradeResult.error.message, stderr: upgradeResult.stderr });
      return formatToolResult({
        success: false,
        summary: `Apt upgrade failed: ${upgradeResult.stderr || upgradeResult.error.message}`,
        stdout: upgradeResult.stdout,
        stderr: upgradeResult.stderr
      });
    }
    reportProgress({ progress: 3, total: 3 });
    return formatToolResult({
      success: true,
      summary: "Apt update and upgrade completed successfully.",
      stdout: `apt update stdout:\n${updateResult.stdout}\napt upgrade stdout:\n${upgradeResult.stdout}`,
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
    const { error, stdout, stderr } = await execWithRetry("apt list --upgradable 2>/dev/null", { maxBuffer: 1024 * 1024 }, 1, 1000, log);
    if (error) {
      log.error("Listing upgradable packages failed", { error: error.message, stderr });
      return formatToolResult({
        success: false,
        summary: `Listing upgradable packages failed: ${stderr || error.message}`,
        stdout,
        stderr
      });
    } else {
      log.info("Listed upgradable packages", { stdout });
      return formatToolResult({
        success: true,
        summary: "Listed upgradable packages successfully.",
        stdout,
        stderr
      });
    }
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
    const cmd = `sudo apt install --only-upgrade -y ${pkg}`;
    reportProgress({ progress: 0, total: 2 });
    log.info("Running apt install --only-upgrade", { cmd });
    const { error, stdout, stderr } = await execWithRetry(cmd, { maxBuffer: 1024 * 1024 }, 1, 1000, log);
    if (error) {
      log.error("Apt only-upgrade failed", { error: error.message, stderr });
      reportProgress({ progress: 1, total: 2 });
      return formatToolResult({
        success: false,
        summary: `Apt only-upgrade failed: ${stderr || error.message}`,
        stdout,
        stderr
      });
    } else {
      log.info("Apt only-upgrade succeeded", { stdout });
      reportProgress({ progress: 2, total: 2 });
      return formatToolResult({
        success: true,
        summary: `Apt only-upgrade succeeded for: ${pkg}`,
        stdout,
        stderr
      });
    }
  }
});

// Tool: Autoremove Apt Packages
server.addTool({
  name: "autoremoveAptPackages",
  description: "Remove packages that were automatically installed to satisfy dependencies for other packages and are now no longer needed.",
  parameters: z.object({}),
  execute: async (_args, { log }) => {
    log.info("Running apt autoremove");
    const { error, stdout, stderr } = await execWithRetry("sudo apt autoremove -y", { maxBuffer: 1024 * 1024 }, 1, 1000, log);
    if (error) {
      log.error("Apt autoremove failed", { error: error.message, stderr });
      return formatToolResult({
        success: false,
        summary: `Apt autoremove failed: ${stderr || error.message}`,
        stdout,
        stderr
      });
    } else {
      log.info("Apt autoremove succeeded", { stdout });
      return formatToolResult({
        success: true,
        summary: "Apt autoremove completed successfully.",
        stdout,
        stderr
      });
    }
  }
});

server.start({
  transportType: "stdio",
});

export { formatToolResult }; 