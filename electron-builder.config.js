/**
 * @type {import('electron-builder').Configuration}
 */
module.exports = {
  appId: 'studio.bossbuttonstudios.shellac',
  productName: 'Shellac',
  asar: true,
  publish: null,  // Non-negotiable: no auto-update, no telemetry
  directories: {
    output: 'release/${version}',
  },
  files: [
    'dist',
    'dist-electron',
    'assets',
  ],
  mac: {
    target: ['dmg'],
    artifactName: 'Shellac-Mac-${version}.${ext}',
  },
  linux: {
    target: ['AppImage'],
    artifactName: 'Shellac-Linux-${version}.${ext}',
  },
}
