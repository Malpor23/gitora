#!/usr/bin/env node
/**
 * Lanzador de desarrollo para Linux: instala un gitora.desktop de usuario y los iconos en
 * ~/.local/share para que la app abierta con `npm start` o desde las pruebas muestre su icono.
 *
 * Por qué hace falta: en Wayland el icono de la ventana no sale de `BrowserWindow.icon`, sino del
 * archivo .desktop cuyo nombre coincide con el app_id (aquí «gitora»). Un paquete instalado ya lo
 * trae; al ejecutar desde el código fuente no existe.
 *
 *   npm run launcher:install      npm run launcher:uninstall
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const desktopFile = path.join(data, 'applications', 'gitora.desktop');
const iconsDir = path.join(data, 'icons', 'hicolor');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

function refresh() {
  for (const [cmd, args] of [
    ['update-desktop-database', [path.dirname(desktopFile)]],
    ['gtk-update-icon-cache', ['-f', '-t', iconsDir]],
  ]) spawnSync(cmd, args, { stdio: 'ignore' });
}

function install() {
  const electron = path.join(root, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electron)) throw new Error('Falta node_modules: ejecuta `npm install` primero.');
  fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
  fs.writeFileSync(
    desktopFile,
    [
      '[Desktop Entry]',
      'Name=Gitora (dev)',
      'Comment=Graphical Git client (development build)',
      `Exec="${electron}" "${root}" %U`,
      `Path=${root}`,
      'Icon=gitora',
      'Terminal=false',
      'Type=Application',
      'Categories=Development;RevisionControl;',
      'StartupWMClass=gitora',
      '',
    ].join('\n'),
  );
  for (const size of SIZES) {
    const dir = path.join(iconsDir, `${size}x${size}`, 'apps');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(root, 'packaging', 'icons', `${size}x${size}.png`), path.join(dir, 'gitora.png'));
  }
  const scalable = path.join(iconsDir, 'scalable', 'apps');
  fs.mkdirSync(scalable, { recursive: true });
  fs.copyFileSync(path.join(root, 'packaging', 'icons', 'gitora.svg'), path.join(scalable, 'gitora.svg'));
  refresh();
  console.log(`Instalado: ${desktopFile}\nIconos: ${iconsDir}`);
}

function uninstall() {
  fs.rmSync(desktopFile, { force: true });
  for (const size of SIZES) fs.rmSync(path.join(iconsDir, `${size}x${size}`, 'apps', 'gitora.png'), { force: true });
  fs.rmSync(path.join(iconsDir, 'scalable', 'apps', 'gitora.svg'), { force: true });
  refresh();
  console.log('Lanzador de desarrollo eliminado.');
}

if (process.platform !== 'linux') {
  console.log('El lanzador de desarrollo solo aplica a Linux.');
} else if (process.argv[2] === 'install') install();
else if (process.argv[2] === 'uninstall') uninstall();
else {
  console.error('Uso: node scripts/dev-launcher.cjs <install|uninstall>');
  process.exit(1);
}
