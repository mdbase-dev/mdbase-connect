const fs = require("node:fs");
const path = require("node:path");

const extension = process.platform === "win32" ? ".exe" : "";
const agent = path.resolve(
  __dirname,
  `../../target/release/mdbase-connect-agent${extension}`
);
const macIcon = path.resolve(__dirname, "assets/app-icon.icns");
const windowsIcon = path.resolve(__dirname, "assets/app-icon.ico");
const windowsStoreAssets = path.resolve(__dirname, "assets/appx");
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

const windowsStoreIdentity =
  process.platform === "win32" &&
  process.env.WINDOWS_STORE_IDENTITY_NAME &&
  process.env.WINDOWS_STORE_PUBLISHER &&
  process.env.WINDOWS_STORE_PUBLISHER_DISPLAY_NAME &&
  process.env.WINDOWS_STORE_PACKAGE_VERSION;

const windowsStoreMakers = windowsStoreIdentity
  ? [
      {
        name: "@electron-forge/maker-appx",
        config: {
          assets: windowsStoreAssets,
          identityName: process.env.WINDOWS_STORE_IDENTITY_NAME,
          packageName: "mdbaseConnect",
          packageDisplayName: "mdbase connect",
          packageDescription:
            "Connect applications to authorized mdbase collections.",
          packageExecutable: "app\\mdbase-connect.exe",
          packageBackgroundColor: "#20334b",
          packageVersion: process.env.WINDOWS_STORE_PACKAGE_VERSION,
          publisher: process.env.WINDOWS_STORE_PUBLISHER,
          publisherDisplayName:
            process.env.WINDOWS_STORE_PUBLISHER_DISPLAY_NAME,
          devCert: process.env.WINDOWS_STORE_DEV_CERT || undefined,
          certPass: process.env.WINDOWS_STORE_DEV_CERT_PASSWORD || undefined
        }
      }
    ]
  : [];

module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: "dev.mdbase.connect",
    executableName: "mdbase-connect",
    icon: platformIcon,
    protocols: [{ name: "mdbase connect", schemes: ["mdbase-connect"] }],
    ...macSigning,
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
        setupIcon: windowsIcon
      }
    },
    { name: "@electron-forge/maker-zip", platforms: ["darwin", "win32"] },
    ...windowsStoreMakers,
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: { icon: macIcon }
    },
    { name: "@electron-forge/maker-deb" },
    { name: "@electron-forge/maker-rpm" }
  ]
};
