import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const exePath = path.join(
  rootDir,
  'release',
  'Multi-Service Console-win32-x64',
  'Multi-Service Console.exe'
);
const workingDir = path.dirname(exePath);
const iconPath = path.join(rootDir, 'assets', 'icon.ico');

const args = new Set(process.argv.slice(2));
const forceBuild = args.has('--build');
const desktopOnly = args.has('--desktop');
const startMenuOnly = args.has('--startmenu');
const createDesktop = !startMenuOnly || desktopOnly;
const createStartMenu = !desktopOnly || startMenuOnly;

if (process.platform !== 'win32') {
  console.error('Shortcuts are currently supported on Windows only.');
  process.exit(1);
}

if (forceBuild || !fs.existsSync(exePath)) {
  console.log('Packaging Multi-Service Console.exe...');
  execFileSync('npm.cmd', ['run', 'package'], {
    cwd: rootDir,
    stdio: 'inherit'
  });
}

if (!fs.existsSync(exePath)) {
  console.error(`Executable not found at: ${exePath}`);
  process.exit(1);
}

const iconLocation = fs.existsSync(iconPath)
  ? `${exePath},0`
  : `${exePath},0`;

const psLines = [
  '$shell = New-Object -ComObject WScript.Shell',
  `$target = '${exePath.replace(/'/g, "''")}'`,
  `$workdir = '${workingDir.replace(/'/g, "''")}'`,
  `$iconLoc = '${iconLocation.replace(/'/g, "''")}'`
];

if (createDesktop) {
  psLines.push(
    "$desktopDir = [Environment]::GetFolderPath('Desktop')",
    "$desktopLnk = Join-Path $desktopDir 'Multi-Service Console.lnk'",
    '$s1 = $shell.CreateShortcut($desktopLnk)',
    '$s1.TargetPath = $target',
    '$s1.WorkingDirectory = $workdir',
    '$s1.IconLocation = $iconLoc',
    "$s1.Description = 'Multi-Service Console'",
    '$s1.Save()',
    'Write-Output "Desktop shortcut: $desktopLnk"'
  );
}

if (createStartMenu) {
  psLines.push(
    "$programsDir = [Environment]::GetFolderPath('Programs')",
    "$startLnk = Join-Path $programsDir 'Multi-Service Console.lnk'",
    '$s2 = $shell.CreateShortcut($startLnk)',
    '$s2.TargetPath = $target',
    '$s2.WorkingDirectory = $workdir',
    '$s2.IconLocation = $iconLoc',
    "$s2.Description = 'Multi-Service Console'",
    '$s2.Save()',
    'Write-Output "Start Menu shortcut: $startLnk"'
  );
}

const encoded = Buffer.from(psLines.join('\n'), 'utf16le').toString('base64');
execFileSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
  { stdio: 'inherit' }
);
