import path from 'path';
import { fileURLToPath } from 'url';
import { packager } from '@electron/packager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function main() {
  const appPaths = await packager({
    dir: rootDir,
    name: 'Multi-Service Console',
    platform: 'win32',
    arch: 'x64',
    out: path.join(rootDir, 'release'),
    overwrite: true,
    prune: false,
    icon: path.join(rootDir, 'assets', 'icon.ico'),
    win32metadata: {
      CompanyName: 'Venkat Apps',
      FileDescription: 'Multi-Service Console',
      ProductName: 'Multi-Service Console',
      InternalName: 'Multi-Service Console',
      OriginalFilename: 'Multi-Service Console.exe'
    },
    ignore: [
      /^\/src($|\/)/,
      /^\/electron($|\/)/,
      /^\/shared($|\/)/,
      /^\/scripts($|\/)/,
      /^\/node_modules($|\/)/,
      /^\/release($|\/)/,
      /^\/tsconfig.*\.json$/,
      /^\/vite\.config\.ts$/,
      /^\/index\.html$/,
      /^\/README\.md$/,
      /^\/\.gitignore$/
    ]
  });

  console.log('Packaged app to:', appPaths.join(', '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
