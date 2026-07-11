// Packages the player for the Steam Deck (linux x64) using the
// Widevine-enabled castlabs Electron distribution.
const { packager } = require("@electron/packager");

packager({
  dir: __dirname,
  out: `${__dirname}/out`,
  name: "deckyam-player",
  platform: "linux",
  arch: "x64",
  electronVersion: "43.0.0+wvcus",
  download: {
    mirrorOptions: {
      mirror: "https://github.com/castlabs/electron-releases/releases/download/",
    },
  },
  asar: true,
  prune: true,
  overwrite: true,
}).then((paths) => {
  console.log("Packaged:", paths.join(", "));
}).catch((e) => {
  console.error("Packaging failed:", e);
  process.exit(1);
});
