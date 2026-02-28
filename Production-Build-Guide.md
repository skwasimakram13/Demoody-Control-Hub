Production Build Guide
This guide explains how to compile Demoody Control Hub into standalone, production-grade applications (
.exe
, .dmg, .AppImage) that you can distribute to other devices.

Build Requirements
Node.js: Ensure Node.js is installed on your computer.
Icons: An icon.png (at least 512x512) must exist in the build/ folder at the root of your project.
How to Build
We have configured electron-builder in our 
package.json
 and a new 
electron-builder.yml
 configuration file. This handles bundling Vite, Electron, and packaging Native dependencies automatically.

From your terminal (D:\Apps\Apps\Desktop App), run one of the following commands based on your target OS:

Build for Windows (.exe)
bash
npm run build:win
This will create a Demoody Control Hub Setup.exe inside the dist folder. Because you are currently using a Windows machine, this is the easiest build to create locally.

Build for Linux (.AppImage, .deb)
bash
npm run build:linux
This will create a .AppImage and .deb file inside the dist folder. You can usually run this from a Windows machine without issues.

Build for macOS (.dmg, .zip)
IMPORTANT

macOS Builds on Windows: Apple strictly requires macOS apps to be compiled and code-signed on a macOS environment. While you can try to run npm run build:mac on Windows, it will often fail or generate an unsigned .zip that Apple Silicon/Intel Macs will refuse to open due to security policies.

To build for Mac, you should:

Clone/copy this exact project codebase onto a Mac computer.
Run npm install on the Mac.
Run npm run build:mac on the Mac.
Where to find your App
Once the build command finishes successfully, look inside the newly generated dist folder in your project directory (D:\Apps\Apps\Desktop App\dist). Inside, you will find your compiled executable files ready for distribution!

How Auto Updates Work
The application is now configured with electron-updater. When the app launches, it automatically checks a remote server for a newer version, downloads it silently in the background, and prompts the user to restart to apply the patch.

Configuring the Update Server (GitHub Releases)
The easiest way to host your updates for free is using public GitHub Releases. Here is how you set it up:

Publish your code to a public GitHub repository (e.g., https://github.com/YourUsername/demoody-hub).
Open your 
electron-builder.yml
 file and add your repository details to the root of the file:
yaml
publish:
  provider: github
  owner: YourUsername
  repo: demoody-hub
In your 
package.json
, make sure you update the "version" field (e.g. from "1.0.0" to "1.0.1").
Build the app using your standard npm run build:XXX command.
Go to your GitHub repository in your web browser, click Releases > Draft a new release.
Name the release exactly matching your package.json version (e.g., v1.0.1).
Most importantly: Upload BOTH the 
.exe
 file AND the latest.yml file generated inside your dist folder to the GitHub release assets list, and hit Publish.
The next time anyone opens the v1.0.0 application, it will scan that GitHub repository, find the latest.yml file, realize there is a 1.0.1 update, and automatically download and install it!
