const fs = require("node:fs");
const path = require("node:path");

const extension = process.platform === "win32" ? ".exe" : "";
const agent = path.resolve(
  __dirname,
  `../../target/release/mdbase-connect-agent${extension}`
);
const macIcon = path.resolve(__dirname, "assets/app-icon.icns");
const windowsIcon = path.resolve(__dirname, "assets/app-icon.ico");
const platformIcon =
  process.platform === "darwin"
    ? macIcon
    : process.platform === "win32"
      ? windowsIcon
      : path.resolve(__dirname, "assets/app-icon.png");

const macSigning =
  process.platform === "darwin" &&
  process.env.APPLE_API_KEY &&
  process.env.APPLE_API_KEY_ID &&
  process.env.APPLE_API_ISSUER
    ? {
        osxSign: {
          identity: process.env.MACOS_CERTIFICATE_IDENTITY || undefined
        },
        osxNotarize: {
          appleApiKey: process.env.APPLE_API_KEY,
          appleApiKeyId: process.env.APPLE_API_KEY_ID,
          appleApiIssuer: process.env.APPLE_API_ISSUER
        }
      }
    : {};

const windowsSign =
  process.platform === "win32" && process.env.WINDOWS_SIGN_WITH_PARAMS
    ? {
        hashes: ["sha256"],
        signWithParams: process.env.WINDOWS_SIGN_WITH_PARAMS,
        timestampServer: "http://ts.ssl.com"
      }
    : undefined;

const windowsSigning = windowsSign ? { windowsSign } : {};
const squirrelSigning = windowsSign ? { windowsSign } : {};

module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: "dev.mdbase.connect",
    executableName: "mdbase-connect",
    icon: platformIcon,
    protocols: [{ name: "mdbase connect", schemes: ["mdbase-connect"] }],
    ...macSigning,
    ...windowsSigning,
    extraResource: fs.existsSync(agent)
      ? [agent]
      : []
  },
  hooks: {
    packageAfterCopy: async () => {
      if (!fs.existsSync(agent)) {
        throw new Error(`Release connector agent is missing: ${agent}`);
      }
    }
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "mdbase_connect",
        authors: "mdbase",
        description: "Connect applications to authorized mdbase collections.",
        iconUrl:
          "https://raw.githubusercontent.com/mdbase-dev/mdbase-connect/main/apps/desktop/assets/app-icon.ico",
        setupIcon: windowsIcon,
        ...squirrelSigning
      }
    },
    { name: "@electron-forge/maker-zip", platforms: ["darwin"] },
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: { icon: macIcon }
    },
    { name: "@electron-forge/maker-deb" },
    { name: "@electron-forge/maker-rpm" }
  ]
};
