# Apt MCP Server

A TypeScript-based Model Context Protocol (MCP) server for controlling the apt package manager on Linux. Designed for integration with AI agents (e.g., Cursor, Claude Desktop, Windsurf) and developer tools, it exposes tools for installing, removing, updating, and querying apt packages using the system's native `apt` and `dpkg` binaries with `sudo` privileges.

---

## Features
- Install, remove, update, and query apt packages via MCP tools
- Secure, passwordless `sudo` assumed for all operations
- Input validation and robust error handling
- Consistent, human-readable output for all tools
- Designed for stdio transport (default for local AI agent integration)

---

## Setup & Installation

1. **Clone the repository:**
   ```sh
   git clone <your-repo-url>
   cd popos-control-mcp
   ```
2. **Install dependencies:**
   ```sh
   npm install
   ```
3. **Build the project:**
   ```sh
   npm run build
   ```
4. **Run the server (stdio transport):**
   ```sh
   npm run dev
   # or
   npm start
   ```

> **Note:** The server assumes the user has passwordless `sudo` for apt operations.

---

## Tools & API Endpoints

All tools are exposed via MCP and can be called by AI agents or clients. Each tool returns a plain text response with a summary, stdout, stderr, and logs (if any).

### 1. `installAptPackage`
- **Description:** Install one or more apt packages.
- **Parameters:**
  - `packages`: array of package names (e.g., `["curl", "git"]`)
- **Example Input:**
  ```json
  { "packages": ["curl"] }
  ```
- **Example Output:**
  ```
  Result: SUCCESS
  Summary: Apt install succeeded for: curl
  [stdout]
  ...
  [stderr]
  ...
  ```

### 2. `removeAptPackage`
- **Description:** Remove one or more apt packages.
- **Parameters:**
  - `packages`: array of package names
- **Example Input:**
  ```json
  { "packages": ["curl"] }
  ```
- **Example Output:**
  ```
  Result: SUCCESS
  Summary: Apt remove succeeded for: curl
  [stdout]
  ...
  [stderr]
  ...
  ```

### 3. `queryAptPackageStatus`
- **Description:** Query if a package is installed, available, or upgradable.
- **Parameters:**
  - `package`: package name (string)
- **Example Input:**
  ```json
  { "package": "curl" }
  ```
- **Example Output:**
  ```
  Result: SUCCESS
  Summary: Status for package curl: Installed=installed, Upgradable=false, Available=available
  [stdout]
  Package: curl
  Installed: installed
  Upgradable: no
  Available: available
  ```

### 4. `updateAptPackages`
- **Description:** Update the apt package list and upgrade all packages.
- **Parameters:** none
- **Example Input:**
  ```json
  {}
  ```
- **Example Output:**
  ```
  Result: SUCCESS
  Summary: Apt update and upgrade completed successfully.
  [stdout]
  apt update stdout:
  ...
  apt upgrade stdout:
  ...
  [stderr]
  ...
  ```

### 5. `listUpgradableAptPackages`
- **Description:** List all upgradable apt packages.
- **Parameters:** none
- **Example Input:**
  ```json
  {}
  ```
- **Example Output:**
  ```
  Result: SUCCESS
  Summary: Listed upgradable packages successfully.
  [stdout]
  ...
  [stderr]
  ...
  ```

### 6. `upgradeSpecificAptPackage`
- **Description:** Upgrade a specific apt package.
- **Parameters:**
  - `package`: package name (string)
- **Example Input:**
  ```json
  { "package": "curl" }
  ```
- **Example Output:**
  ```
  Result: SUCCESS
  Summary: Apt only-upgrade succeeded for: curl
  [stdout]
  ...
  [stderr]
  ...
  ```

---

## Example Usage

### CLI (stdio transport)
You can test the server using the MCP CLI or by connecting with an AI agent (e.g., Cursor, Claude Desktop).

### Node.js Example
```js
const { Client } = require("@modelcontextprotocol/sdk/client");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio");

const client = new Client({ name: "test-client", version: "1.0.0" });
const transport = new StdioClientTransport();

(async () => {
  await client.connect(transport);
  const result = await client.callTool("installAptPackage", { packages: ["curl"] });
  console.log(result);
})();
```

---

## Error Handling & Troubleshooting
- All errors are returned in a consistent format with `Result: ERROR` and a summary.
- Common error causes:
  - Invalid package name: check spelling and allowed characters
  - Package not found: ensure the package exists in your repositories
  - Permission denied: ensure passwordless sudo is configured
  - Apt lock: the server retries once automatically, but if the error persists, wait and try again
- Example error output:
  ```
  Result: ERROR
  Summary: Apt install failed: E: Unable to locate package notarealpackage
  [stdout]
  ...
  [stderr]
  E: Unable to locate package notarealpackage
  ```

---

## FAQ

**Q: Does the server require passwordless sudo?**
A: Yes, all apt/dpkg commands are run with sudo and assume no password prompt.

**Q: What transport does the server use?**
A: Stdio by default, for easy integration with local AI agents and tools.

**Q: Can I use this server remotely?**
A: You can adapt it to use HTTP/SSE transport, but stdio is recommended for local/agent use.

**Q: How do I add new tools?**
A: Add a new `server.addTool` block in `src/index.ts` following the existing pattern.

---

## License
MIT 