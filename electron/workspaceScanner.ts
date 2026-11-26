import fs from 'fs';
import path from 'path';
import { DiscoveredServiceCandidate, ServiceType } from '../shared/types';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'build',
  'target',
  'release',
  '.idea',
  '.vscode',
  '.next',
  '__pycache__',
  '.gradle'
]);

const MAX_DEPTH = 3;

export function scanFolderForServices(
  rootFolder: string
): DiscoveredServiceCandidate[] {
  const candidates: DiscoveredServiceCandidate[] = [];
  const rootName = path.basename(rootFolder) || 'Workspace';

  function walk(dir: string, depth: number) {
    if (depth > MAX_DEPTH) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const fileNames = new Set(
      entries.filter((e) => e.isFile()).map((e) => e.name)
    );
    const folderName = path.basename(dir);
    const groupName = depth === 0 ? rootName : rootName;

    // 1. Node / package.json
    if (fileNames.has('package.json')) {
      try {
        const pkgPath = path.join(dir, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
          name?: string;
          scripts?: Record<string, string>;
        };
        const scripts = pkg.scripts ?? {};
        const preferred = ['dev', 'start', 'serve', 'watch', 'backend', 'api'];
        const picked = Object.keys(scripts).filter((k) =>
          preferred.some((p) => k === p || k.startsWith(`${p}:`))
        );
        const scriptKeys =
          picked.length > 0 ? picked : Object.keys(scripts).slice(0, 3);

        const runner = fileNames.has('pnpm-lock.yaml')
          ? 'pnpm'
          : fileNames.has('yarn.lock')
            ? 'yarn'
            : 'npm';

        for (const scriptKey of scriptKeys) {
          const cmd =
            runner === 'yarn'
              ? `yarn ${scriptKey}`
              : `${runner} run ${scriptKey}`;
          const serviceName = pkg.name
            ? `${pkg.name} (${scriptKey})`
            : `${folderName} (${scriptKey})`;

          candidates.push({
            tempId: `${pkgPath}::${scriptKey}`,
            name: serviceName,
            group: groupName,
            type: 'node',
            command: cmd,
            cwd: dir,
            ports: inferPortsFromText(scripts[scriptKey] ?? ''),
            sourceFile: pkgPath
          });
        }
      } catch {
        // Ignore malformed package.json
      }
    }

    // 2. Maven (pom.xml)
    if (fileNames.has('pom.xml')) {
      const pomPath = path.join(dir, 'pom.xml');
      let pomText = '';
      try {
        pomText = fs.readFileSync(pomPath, 'utf8');
      } catch {
        // Ignore read error
      }
      const isSpringBoot = pomText.includes('spring-boot');
      const mvnCmd = fileNames.has('mvnw.cmd') ? 'mvnw.cmd' : 'mvn';
      if (isSpringBoot || depth > 0) {
        candidates.push({
          tempId: `${pomPath}::mvn`,
          name: `${folderName}`,
          group: groupName,
          type: 'java',
          command: isSpringBoot
            ? `${mvnCmd} spring-boot:run`
            : `${mvnCmd} test-compile exec:java`,
          cwd: dir,
          ports: inferJavaPorts(dir),
          sourceFile: pomPath
        });
      }
    }

    // 3. Gradle (build.gradle / build.gradle.kts)
    if (fileNames.has('build.gradle') || fileNames.has('build.gradle.kts')) {
      const gradleFile = fileNames.has('build.gradle.kts')
        ? 'build.gradle.kts'
        : 'build.gradle';
      const gradlePath = path.join(dir, gradleFile);
      const gradlew = fileNames.has('gradlew.bat') ? 'gradlew.bat' : 'gradle';
      let gradleText = '';
      try {
        gradleText = fs.readFileSync(gradlePath, 'utf8');
      } catch {
        // Ignore
      }
      const isSpring = gradleText.includes('org.springframework.boot');
      candidates.push({
        tempId: `${gradlePath}::gradle`,
        name: `${folderName}`,
        group: groupName,
        type: 'java',
        command: isSpring ? `${gradlew} bootRun` : `${gradlew} run`,
        cwd: dir,
        ports: inferJavaPorts(dir),
        sourceFile: gradlePath
      });
    }

    // 4. Docker Compose
    for (const composeName of [
      'docker-compose.yml',
      'docker-compose.yaml',
      'compose.yml',
      'compose.yaml'
    ]) {
      if (fileNames.has(composeName)) {
        const composePath = path.join(dir, composeName);
        let type: ServiceType = 'docker';
        try {
          const text = fs.readFileSync(composePath, 'utf8');
          if (/kafka/i.test(text)) type = 'kafka';
        } catch {
          // Ignore
        }
        candidates.push({
          tempId: `${composePath}::compose`,
          name: `${folderName} (Docker Compose)`,
          group: groupName,
          type,
          command: `docker compose -f ${composeName} up`,
          cwd: dir,
          sourceFile: composePath
        });
        break;
      }
    }

    // 5. Python FastAPI / Django / main.py
    if (fileNames.has('manage.py')) {
      const pyPath = path.join(dir, 'manage.py');
      candidates.push({
        tempId: `${pyPath}::django`,
        name: `${folderName} (Django)`,
        group: groupName,
        type: 'python',
        command: 'python manage.py runserver',
        cwd: dir,
        ports: [8000],
        sourceFile: pyPath
      });
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  }

  walk(rootFolder, 0);
  return candidates;
}

function inferPortsFromText(text: string): number[] | undefined {
  const match = text.match(/(?:--port|-p|PORT=)\s*(\d{2,5})/i);
  if (match) {
    const port = Number.parseInt(match[1], 10);
    if (port > 0 && port < 65536) return [port];
  }
  return undefined;
}

function inferJavaPorts(dir: string): number[] | undefined {
  const candidates = [
    path.join(dir, 'src', 'main', 'resources', 'application.properties'),
    path.join(dir, 'src', 'main', 'resources', 'application.yml'),
    path.join(dir, 'src', 'main', 'resources', 'application.yaml')
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, 'utf8');
      const propMatch = content.match(/server\.port\s*[:=]\s*(\d{2,5})/);
      if (propMatch) {
        return [Number.parseInt(propMatch[1], 10)];
      }
      const yamlMatch = content.match(/port:\s*(\d{2,5})/);
      if (yamlMatch) {
        return [Number.parseInt(yamlMatch[1], 10)];
      }
    } catch {
      // Ignore
    }
  }
  return undefined;
}
