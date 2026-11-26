# Multi-Service Console

IntelliJ-style multi-service process launcher and live console log viewer built with **Electron + React + TypeScript + Vite**.

## Features

- **Left Process Registry & Groups:** Configure Java/Spring Boot, Node.js, Kafka, Docker Compose, Python, or shell commands grouped by project/stack. Start/stop individual processes or entire groups.
- **PID & Port Visibility:** Displays shell and child PIDs (click to copy), live listening TCP ports, uptime, and a 1-click **Kill Port** button to clear stuck ports.
- **Windows Process Tree Cleanup:** Stops full Windows process trees (`taskkill /PID ... /T` with `/F` fallback) so child `java.exe` / `node.exe` processes do not leak when stopping a wrapper command.
- **IntelliJ-Style Console:**
  - Virtualized log viewport with ANSI color rendering, timestamps, and soft line-wrap toggle.
  - **Auto-Scroll & Scroll Lock:** Auto-follows latest output, pauses automatically if you scroll up, or locks scroll explicitly via the toolbar.
  - **Find & Grep Filter (`Ctrl+F`):** Case-sensitive, Regex, match counter, Next/Prev navigation, and **Filter Only** grep mode.
  - **Error Block Detection & 1-Click Copy:** Automatically groups exceptions and stack traces (`at ...`, `Caused by:`), adds inline **Copy Error** buttons, Prev/Next Error navigation, **Copy Last Error**, and **Copy Errors**.
- **Pop-Out Window:** Detach any service console into a separate resizable window (great for multi-monitor debugging).
- **Global + Workspace Persistence:** Store services globally in `%APPDATA%\multi-service-console\services.json` or per-workspace in `<workspace>\multi-service-console.json` (with automatic relative `cwd` paths for Git sharing), and switch via the top-bar profile dropdown or by passing a folder path on launch.
- **Workspace Scanner & JSON Import/Export:** Auto-discover commands from `package.json`, `pom.xml`, `build.gradle`, `docker-compose.yml`, and `manage.py`, or import/export service configs as JSON.

## Run

```bash
npm install
npm start
```

For hot-reload development:

```bash
npm run dev
```

To package a Windows `.exe` under `release/`:

```bash
npm run package
```
