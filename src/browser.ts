import { spawn } from "node:child_process";
export async function openBrowser(url: string) {
  // Fixed executables, argument arrays, no shell interpolation of the URL.
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error("Could not open browser")));
  });
}
