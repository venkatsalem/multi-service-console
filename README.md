<p align="center">
  <img src="assets/icon.png" alt="Multi-Service Console" width="96" />
</p>

# Multi-Service Console

An IntelliJ-inspired desktop process launcher and live console log viewer for running multiple microservices, frontend dev servers, databases, and messaging infrastructure (Java / Spring Boot, Node.js, Kafka, Docker Compose, Python, or custom shell commands) from a single window.

Built with **Electron**, **React**, **TypeScript**, and **Vite**.

---

## Why Multi-Service Console?

When working on multi-service applications, juggling half a dozen terminal tabs—remembering commands, working directories, ports, and hunting through scrolled-off stack traces—gets exhausting. Multi-Service Console keeps all your project commands organized on the left and gives you a fast, searchable, IntelliJ-style console on the right.

## Features

### Left Process Registry & Stack Management
- **Project Groups:** Organize services by project or stack with collapsible headers and **Start Group** / **Stop Group** controls.
- **Drag-and-Drop Reordering:** Drag service cards to keep frequently used processes at the top and less used ones at the bottom; group startup order follows your arrangement.
- **Clear Status Distinction:** Running, starting, and crashed services stand out with colored accent borders while stopped services stay subtly dimmed.
- **One-Click Run / Stop / Restart:** Prominent **Start** / **Stop** buttons right on each service card.
- **Right-Click Context Menu:** Right-click any process card to **Edit Process...** (including **Delete Process**), **Start / Stop / Restart**, **Pop Out Console**, **Show in Explorer**, or **Open Terminal** in that service's working directory.
- **Multi-Line Commands:** Write multiple commands on separate lines in the **Command** box and they automatically chain with `&&` (e.g. `mvn compile` followed by `mvn spring-boot:run`), with `^` line-continuation and `#` comment support.
- **Live PID & Port Tracking:** Displays shell and child PIDs (click to copy), live listening TCP ports, uptime, unread error badges, and a 1-click **Kill Port** button to clear stuck ports.
- **Reliable Process Tree Cleanup:** Stops full Windows process trees (`taskkill /T /F` + direct child/port PID cleanup) so background `java.exe` / `node.exe` processes do not linger.

### IntelliJ-Style Console Viewer
- **Virtualized 60fps Viewport:** Handles up to 25,000 buffered log lines per service with ANSI color rendering, optional timestamps (hidden by default; toggle with **Time**), and soft line wrapping (**Wrap**).
- **Smart Auto-Scroll & Scroll Lock:** Follows the latest output automatically, pauses when you scroll up to inspect an error (with a floating **Jump to Bottom** button), or locks explicitly via **Auto-Scroll / Scroll Locked**.
- **Find & Grep Filter (`Ctrl+F`):** Search with Match Case (`Aa`), Regular Expressions (`.*`), Prev/Next match navigation, match counter, and **Filter Only** (grep) mode.
- **Level Filtering & Error Helpers:** Filter by `All`, `Errors`, or `Warn+Err`, jump between error blocks (`Prev Err` / `Next Err`), or copy error stack traces in one click via **Copy Last Error** and **Copy Errors**.
- **Clean Selection & Right-Click Copy:** Line numbers and timestamps are excluded from text selection—select any log text and press `Ctrl+C` or right-click for **Copy**, **Copy Lines** (copies all full lines touched by your selection), **Copy Error Block**, **Find in Console**, or **Clear Console**.
- **Pop-Out Windows:** Detach any service console into a separate larger window for multi-monitor debugging.

### Global & Workspace Configuration
- **Global Profile:** Stores personal services in `%APPDATA%\multi-service-console\services.json`.
- **Workspace Mode (`multi-service-console.json`):** Open any project folder to store services directly in `<workspace>\multi-service-console.json` with automatic relative `cwd` paths (Git-friendly for sharing with teammates), or pass a workspace path as a CLI argument on launch.
- **Workspace Scanner:** Scan a folder up to 3 levels deep to auto-discover `package.json` scripts, Maven (`pom.xml`), Gradle (`build.gradle`), `docker-compose.yml`, and Django (`manage.py`) services.
- **JSON Import / Export & Themes:** Export or import service lists as JSON and switch between **System**, **Light**, and **Dark** themes.

---

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+ recommended)
- npm (included with Node.js)

### Run From Source

```bash
git clone https://github.com/venkatsalem/multi-service-console.git
cd multi-service-console
npm install
npm start
```

For hot-reload development (Vite dev server + Electron):

```bash
npm run dev
```

### Build Windows `.exe` & Create Shortcuts

Package a standalone Windows executable under `release/`:

```bash
npm run package
```

Create Windows **Desktop** and **Start Menu** shortcuts (automatically packages the `.exe` if not built yet):

```bash
npm run shortcut
```

Optional flags:

```bash
npm run shortcut -- --build      # Force rebuild before updating shortcuts
npm run shortcut -- --desktop    # Desktop shortcut only
npm run shortcut -- --startmenu  # Start Menu shortcut only
```

---

## Workspace Config Format

Workspace configs live at `<workspace>/multi-service-console.json` and support relative `cwd` paths:

```json
{
  "version": 1,
  "services": [
    {
      "id": "order-service",
      "name": "Order Service",
      "group": "Backend",
      "type": "java",
      "command": "mvn compile\nmvn spring-boot:run",
      "cwd": "./order-service",
      "ports": [8081],
      "readyPattern": "Started .*Application in"
    },
    {
      "id": "web-ui",
      "name": "Web UI",
      "group": "Frontend",
      "type": "node",
      "command": "npm run dev",
      "cwd": "./web-ui",
      "ports": [5173]
    }
  ]
}
```

---

## Project Structure

```text
multi-service-console/
├── assets/                  # App icon (icon.png, icon.ico)
├── electron/
│   ├── main.ts              # Electron windows, IPC handlers, dialogs, pop-outs
│   ├── preload.ts           # Typed contextBridge API
│   ├── processManager.ts    # Child process lifecycle, Windows tree kill, log buffer
│   ├── ansiParser.ts        # ANSI SGR parser & log/stack-trace classifier
│   └── workspaceScanner.ts  # Auto-discovery for Maven/Gradle/Node/Docker/Python
├── shared/
│   └── types.ts             # Shared TypeScript interfaces
├── src/
│   ├── App.tsx              # Main shell, top bar, workspace switcher, pop-out mode
│   ├── components/
│   │   ├── ProcessSidebar.tsx
│   │   ├── ConsolePane.tsx
│   │   ├── ServiceFormModal.tsx
│   │   └── ScanWorkspaceModal.tsx
│   └── styles.css           # Light/Dark themes & layout styles
└── scripts/
    ├── package.mjs          # @electron/packager build script
    └── create-shortcut.mjs  # Windows Desktop & Start Menu shortcut generator
```

---

## Contributing

Contributions, bug reports, and feature ideas are welcome!

1. Fork the repository and create a feature branch.
2. Run `npm run build` to verify TypeScript (`tsconfig.json` and `tsconfig.electron.json`) and Vite production builds pass cleanly.
3. Open a pull request with a clear description of your change.

## License

Licensed under the [MIT License](LICENSE).
