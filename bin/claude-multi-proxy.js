#!/usr/bin/env node
/* eslint-disable no-console */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_PORT = 8317;
const CODEX_MODEL_ALIAS = "codex";
const CODEX_MODEL_TARGET = "gpt-5.3-codex";
const LABEL_PROXY = "com.claude-multi-proxy";

function nowTs() {
  return Date.now().toString();
}

function log(msg) {
  console.log(`[claude-multi-proxy] ${msg}`);
}

function warn(msg) {
  console.error(`[claude-multi-proxy][WARN] ${msg}`);
}

function fail(msg, code = 1) {
  console.error(`[claude-multi-proxy][FAIL] ${msg}`);
  process.exit(code);
}

function usage(code = 0) {
  const txt = `Usage:
  claude-multi-proxy [command]

Commands:
  install          Install + configure + start (default)
  claude-login     Login to Claude (Anthropic) via OAuth
  codex-login      Login to Codex (OpenAI) via OAuth
  start            Start proxy LaunchAgent
  stop             Stop proxy LaunchAgent
  status           Show status
  uninstall        Remove LaunchAgent + restore Claude Code settings (keeps proxy files)
  purge            Uninstall + remove proxy files
  help             Show this help

Examples:
  npx -y claude-multi-proxy@latest
  npx -y claude-multi-proxy@latest --profile work
  npx -y claude-multi-proxy@latest --claude-settings-path ~/custom/claude-settings.json
  npx -y claude-multi-proxy@latest --no-global-settings
  npx -y claude-multi-proxy@latest claude-login
  npx -y claude-multi-proxy@latest codex-login
  npx -y claude-multi-proxy@latest status
  npx -y claude-multi-proxy@latest purge

Options:
  --profile <name>              Isolate proxy state by profile (default: default)
  --claude-settings-path <path> Override Claude settings file path
  --no-global-settings          Skip Claude settings update during install/uninstall

How it works:
  1. Install CLIProxyAPI as a local proxy
  2. Login to both Claude and Codex via OAuth
  3. Use /model in Claude Code to switch between providers:
     - /model opus    → Claude Opus (Anthropic)
     - /model sonnet  → Claude Sonnet (Anthropic)
     - /model haiku   → Claude Haiku (Anthropic)
     - /model codex   → GPT-5.3 Codex (OpenAI)
`;
  console.log(txt);
  process.exit(code);
}

function parseArgs(argv) {
  const args = [...argv];
  const out = { command: "install", profile: "default", noGlobalSettings: false };

  if (args.length > 0 && !args[0].startsWith("-")) {
    out.command = args.shift();
  }

  while (args.length > 0) {
    const a = args.shift();
    if (a === "--help" || a === "-h" || a === "help") return { ...out, command: "help" };
    if (a === "--yes" || a === "-y") continue;
    if (a === "--profile") {
      if (args.length === 0) fail("--profile requires a value");
      out.profile = args.shift();
      continue;
    }
    if (a === "--claude-settings-path") {
      if (args.length === 0) fail("--claude-settings-path requires a value");
      out.claudeSettingsPath = args.shift();
      continue;
    }
    if (a === "--no-global-settings") {
      out.noGlobalSettings = true;
      continue;
    }
    fail(`unknown arg: ${a}`);
  }

  return out;
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readText(p) {
  return fs.readFileSync(p, "utf8");
}

function writeFileAtomic(p, content, mode) {
  const dir = path.dirname(p);
  ensureDir(dir);
  const tmp = `${p}.tmp.${process.pid}.${nowTs()}`;
  fs.writeFileSync(tmp, content, "utf8");
  if (mode != null) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, p);
}

function backupFile(p) {
  if (!exists(p)) return null;
  const bak = `${p}.backup.${nowTs()}`;
  fs.copyFileSync(p, bak);
  return bak;
}

function run(cmd, args, opts = {}) {
  const {
    cwd,
    allowFail = false,
    captureStdout = true,
    captureStderr = true,
    inherit = false,
  } = opts;

  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: inherit
      ? "inherit"
      : [
          "ignore",
          captureStdout ? "pipe" : "inherit",
          captureStderr ? "pipe" : "inherit",
        ],
  });

  if (!allowFail && (r.error || r.status !== 0)) {
    const msg = [
      `${cmd} ${args.join(" ")}`,
      r.error ? String(r.error) : "",
      r.stdout ? `stdout:\n${r.stdout}` : "",
      r.stderr ? `stderr:\n${r.stderr}` : "",
    ].filter(Boolean).join("\n");
    fail(msg);
  }
  return r;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "claude-multi-proxy" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} (${url})`);
  }
  return await res.json();
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "claude-multi-proxy" },
  });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
  ensureDir(path.dirname(destPath));
  const tmp = `${destPath}.tmp.${process.pid}.${nowTs()}`;
  const ab = await res.arrayBuffer();
  fs.writeFileSync(tmp, Buffer.from(ab));
  fs.renameSync(tmp, destPath);
}

function findFileRecursive(rootDir, names) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (it.isFile() && names.includes(it.name)) {
        return p;
      }
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readPortFromProxyConfig(configFile) {
  if (!exists(configFile)) return null;
  try {
    const m = readText(configFile).match(/^\s*port:\s*(\d+)\s*$/m);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) return null;
    return n;
  } catch {
    return null;
  }
}

async function resolveProxyPort({ configFile }) {
  const fromConfig = readPortFromProxyConfig(configFile);
  // Always use the configured port (or default). During install we stop
  // existing proxy first, so the port should be free.
  return fromConfig ?? DEFAULT_PORT;
}

async function proxyHealthcheck(port) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { Authorization: "Bearer sk-dummy" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

function profileDirName(profile) {
  return profile === "default" ? ".cli-proxy-api" : `.cli-proxy-api-${profile}`;
}

function validateProfile(profileRaw) {
  const profile = profileRaw && profileRaw.trim() ? profileRaw.trim() : "default";
  if (!/^[a-zA-Z0-9._-]+$/.test(profile) || profile === "." || profile === "..") {
    fail(`invalid profile: ${profileRaw}`);
  }
  return profile;
}

function proxyConfigYaml({ port, authDirName }) {
  return `# claude-multi-proxy config
# Claude + Codex dual OAuth proxy

host: "127.0.0.1"
port: ${port}

auth-dir: "~/${authDirName}"

api-keys:
  - "sk-dummy"

request-retry: 3

# "codex" alias → ${CODEX_MODEL_TARGET}
# Use /model codex in Claude Code to switch
oauth-model-alias:
  codex:
    - name: "${CODEX_MODEL_TARGET}"
      alias: "${CODEX_MODEL_ALIAS}"
      fork: true

payload:
  override:
    - models:
        - name: "gpt-*"
          protocol: "codex"
      params:
        "reasoning.effort": "high"
`;
}

function buildPlistProxy({ labelProxy, proxyBin, configFile, homeDir, proxyLog }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${labelProxy}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${proxyBin}</string>
    <string>-config</string>
    <string>${configFile}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${homeDir}</string>
  <key>StandardOutPath</key><string>${proxyLog}</string>
  <key>StandardErrorPath</key><string>${proxyLog}</string>
</dict></plist>
`;
}

async function installCliProxyApiBinary({ proxyBin }) {
  if (exists(proxyBin)) {
    log(`CLIProxyAPI already installed: ${proxyBin}`);
    return;
  }

  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
  if (!arch) fail(`unsupported architecture: ${process.arch}`);

  ensureDir(path.dirname(proxyBin));

  log("Downloading CLIProxyAPI release from GitHub...");
  const rel = await fetchJson("https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest");
  const suffix = `darwin_${arch}.tar.gz`;
  const asset = (rel.assets || []).find((a) => typeof a?.name === "string" && a.name.includes(suffix));
  if (!asset?.browser_download_url) {
    fail(`could not find asset containing: ${suffix}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-multi-proxy-"));
  const tarball = path.join(tmpDir, "cli-proxy-api.tar.gz");
  await downloadToFile(asset.browser_download_url, tarball);

  log("Extracting tarball...");
  run("tar", ["-xzf", tarball, "-C", tmpDir]);

  const found = findFileRecursive(tmpDir, ["cli-proxy-api", "CLIProxyAPI"]);
  if (!found) fail("failed to locate extracted binary");

  fs.copyFileSync(found, proxyBin);
  fs.chmodSync(proxyBin, 0o755);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  log(`Installed: ${proxyBin}`);
}

function updateClaudeSettings({ claudeSettingsPath, port }) {
  ensureDir(path.dirname(claudeSettingsPath));
  if (!exists(claudeSettingsPath)) {
    writeFileAtomic(claudeSettingsPath, "{}\n", 0o600);
  }

  backupFile(claudeSettingsPath);

  let json;
  try {
    json = JSON.parse(readText(claudeSettingsPath));
  } catch {
    fail(`failed to parse JSON: ${claudeSettingsPath}`);
  }

  if (!json || typeof json !== "object") json = {};
  if (!json.env || typeof json.env !== "object") json.env = {};

  // Only set proxy routing — preserve original Claude model slots
  json.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  json.env.ANTHROPIC_AUTH_TOKEN = "sk-dummy";

  // Keep original Claude models for each slot
  json.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-4-6";
  json.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-sonnet-4-5-20250929";
  json.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-haiku-4-5-20251001";

  writeFileAtomic(claudeSettingsPath, `${JSON.stringify(json, null, 2)}\n`, 0o600);
}

function resolvePaths({ homeDir, profile, claudeSettingsPath }) {
  const normalizedProfile = validateProfile(profile);
  const authDirName = profileDirName(normalizedProfile);

  const proxyDir = path.join(homeDir, authDirName);
  const configFile = path.join(proxyDir, "config.yaml");
  const proxyLog = path.join(proxyDir, "proxy.log");
  const proxyBin = getProxyBin(proxyDir);
  const labelProxy = normalizedProfile === "default" ? LABEL_PROXY : `${LABEL_PROXY}.${normalizedProfile}`;
  const plistProxy = path.join(homeDir, "Library", "LaunchAgents", `${labelProxy}.plist`);
  const resolvedClaudeSettingsPath = claudeSettingsPath
    || path.join(homeDir, ".claude", normalizedProfile === "default" ? "settings.json" : `settings.${normalizedProfile}.json`);

  return {
    profile: normalizedProfile,
    authDirName,
    proxyDir,
    configFile,
    proxyBin,
    proxyLog,
    labelProxy,
    plistProxy,
    claudeSettingsPath: resolvedClaudeSettingsPath,
  };
}

function cleanupClaudeSettings({ claudeSettingsPath }) {
  if (!exists(claudeSettingsPath)) return;

  backupFile(claudeSettingsPath);

  let json;
  try {
    json = JSON.parse(readText(claudeSettingsPath));
  } catch {
    fail(`failed to parse JSON: ${claudeSettingsPath}`);
  }

  if (!json || typeof json !== "object") return;

  // Remove model if it was set to codex
  if (json.model === CODEX_MODEL_ALIAS || json.model === CODEX_MODEL_TARGET) {
    delete json.model;
  }

  if (json.env && typeof json.env === "object") {
    delete json.env.ANTHROPIC_BASE_URL;
    delete json.env.ANTHROPIC_AUTH_TOKEN;
    delete json.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    delete json.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    delete json.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  }

  writeFileAtomic(claudeSettingsPath, `${JSON.stringify(json, null, 2)}\n`, 0o600);
}

function getUsername() {
  if (process.env.USER && process.env.USER.trim()) return process.env.USER.trim();
  return os.userInfo().username;
}

function getUid() {
  const r = run("id", ["-u"]);
  return Number(String(r.stdout || "").trim());
}

function launchctlBootout(uid, label) {
  run("launchctl", ["bootout", `gui/${uid}/${label}`], { allowFail: true });
}

function launchctlBootstrap(uid, plistPath) {
  run("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { allowFail: true });
}

function launchctlKickstart(uid, label) {
  run("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`], { allowFail: true });
}

function launchctlPrint(uid, label) {
  const r = run("launchctl", ["print", `gui/${uid}/${label}`], { allowFail: true });
  return r.status === 0;
}

async function waitForHealthy(port, msTotal = 8000) {
  const started = Date.now();
  while (Date.now() - started < msTotal) {
    if (await proxyHealthcheck(port)) return true;
    await sleep(250);
  }
  return false;
}

function getProxyBin(proxyDir) {
  return path.join(proxyDir, "cli-proxy-api");
}

function hasAuthFiles(proxyDir) {
  if (!exists(proxyDir)) return { hasClaude: false, hasCodex: false, files: [] };
  const files = fs.readdirSync(proxyDir).filter((f) => f.endsWith(".json"));
  const hasClaude = files.some((f) => f.startsWith("claude-"));
  const hasCodex = files.some((f) => f.startsWith("codex-"));
  return { hasClaude, hasCodex, files };
}

async function stopExistingProxy(uid, labelProxy = LABEL_PROXY) {
  // Stop our own LaunchAgent
  launchctlBootout(uid, labelProxy);

  // Also clean up known legacy labels from upstream codex-claudecode-proxy
  const username = getUsername();
  for (const legacy of [
    `com.${username}.cli-proxy-api`,
    `com.${username}.cli-proxy-api-token-sync`,
    "com.cliproxyapi",
  ]) {
    launchctlBootout(uid, legacy);
  }

  // Wait for port to free up
  await sleep(1000);
}

async function installFlow(opts = {}) {
  if (process.platform !== "darwin") {
    fail("macOS only (LaunchAgents-based install).");
  }

  const homeDir = os.homedir();
  const uid = getUid();
  const paths = resolvePaths({ homeDir, profile: opts.profile, claudeSettingsPath: opts.claudeSettingsPath });

  ensureDir(paths.proxyDir);
  ensureDir(path.dirname(paths.plistProxy));

  // 1. Stop existing proxy first (prevents port conflict)
  log(`Stopping existing proxy (profile: ${paths.profile})...`);
  await stopExistingProxy(uid, paths.labelProxy);

  // 2. Install CLIProxyAPI binary
  await installCliProxyApiBinary({ proxyBin: paths.proxyBin });

  // 3. Resolve port and write config
  const port = await resolveProxyPort({ configFile: paths.configFile });
  log("Writing proxy config...");
  writeFileAtomic(paths.configFile, proxyConfigYaml({ port, authDirName: paths.authDirName }), 0o644);

  // 4. Check OAuth status
  const auth = hasAuthFiles(paths.proxyDir);
  if (!auth.hasClaude) {
    log("");
    log("Claude OAuth not found. Running claude-login...");
    run(paths.proxyBin, ["-config", paths.configFile, "-claude-login"], { inherit: true, allowFail: true });
  }
  if (!auth.hasCodex) {
    log("");
    log("Codex OAuth not found. Running codex-login...");
    run(paths.proxyBin, ["-config", paths.configFile, "-codex-login"], { inherit: true, allowFail: true });
  }

  // Re-check auth after login attempts
  const authAfter = hasAuthFiles(paths.proxyDir);
  if (!authAfter.hasClaude && !authAfter.hasCodex) {
    fail("No OAuth credentials found. Run 'claude-login' or 'codex-login' first.");
  }

  // 5. Write and load LaunchAgent
  log("Writing LaunchAgent...");
  writeFileAtomic(paths.plistProxy, buildPlistProxy({
    labelProxy: paths.labelProxy,
    proxyBin: paths.proxyBin,
    configFile: paths.configFile,
    homeDir,
    proxyLog: paths.proxyLog,
  }), 0o644);

  log("Starting proxy...");
  launchctlBootstrap(uid, paths.plistProxy);
  launchctlKickstart(uid, paths.labelProxy);

  const healthy = await waitForHealthy(port, 10000);
  if (!healthy) fail(`proxy did not become healthy (check ${paths.proxyLog})`);

  // 6. Update Claude Code settings
  if (opts.noGlobalSettings) {
    log("Skipping Claude Code settings update (--no-global-settings).");
  } else {
    log("Updating Claude Code settings...");
    updateClaudeSettings({ claudeSettingsPath: paths.claudeSettingsPath, port });
  }

  log("");
  log("All done!");
  log(`  Profile: ${paths.profile}`);
  log(`  Proxy: http://127.0.0.1:${port}`);
  log(`  Config: ${paths.configFile}`);
  log(`  Log: ${paths.proxyLog}`);
  if (!opts.noGlobalSettings) {
    log(`  Claude settings: ${paths.claudeSettingsPath}`);
  }
  log("");
  log("Available models in Claude Code (/model):");
  log("  opus    → Claude Opus (Anthropic)");
  log("  sonnet  → Claude Sonnet (Anthropic)");
  log("  haiku   → Claude Haiku (Anthropic)");
  log("  codex   → GPT-5.3 Codex (OpenAI)");
  log("");
  if (!authAfter.hasClaude) {
    warn("Claude OAuth missing — run: npx claude-multi-proxy claude-login");
  }
  if (!authAfter.hasCodex) {
    warn("Codex OAuth missing — run: npx claude-multi-proxy codex-login");
  }
  log("Restart Claude Code to apply changes.");
}

async function oauthLoginFlow(provider, opts = {}) {
  if (process.platform !== "darwin") fail("macOS only.");
  const homeDir = os.homedir();
  const paths = resolvePaths({ homeDir, profile: opts.profile, claudeSettingsPath: opts.claudeSettingsPath });

  if (!exists(paths.proxyBin)) {
    fail(`CLIProxyAPI not installed for profile '${paths.profile}'. Run 'install --profile ${paths.profile}' first.`);
  }

  const flag = provider === "claude" ? "-claude-login" : "-codex-login";
  log(`Starting ${provider} OAuth login (profile: ${paths.profile})...`);
  run(paths.proxyBin, ["-config", paths.configFile, flag], { inherit: true });
  log(`${provider} login completed.`);
}

async function startFlow(opts = {}) {
  if (process.platform !== "darwin") fail("macOS only.");
  const homeDir = os.homedir();
  const uid = getUid();
  const paths = resolvePaths({ homeDir, profile: opts.profile, claudeSettingsPath: opts.claudeSettingsPath });
  const port = readPortFromProxyConfig(paths.configFile) ?? DEFAULT_PORT;

  if (!exists(paths.plistProxy)) fail(`missing plist: ${paths.plistProxy} (run install first)`);
  launchctlBootstrap(uid, paths.plistProxy);
  launchctlKickstart(uid, paths.labelProxy);

  const healthy = await waitForHealthy(port, 10000);
  if (!healthy) fail("proxy did not become healthy");
  log(`proxy started (profile: ${paths.profile})`);
}

async function stopFlow(opts = {}) {
  if (process.platform !== "darwin") fail("macOS only.");
  const homeDir = os.homedir();
  const uid = getUid();
  const paths = resolvePaths({ homeDir, profile: opts.profile, claudeSettingsPath: opts.claudeSettingsPath });
  launchctlBootout(uid, paths.labelProxy);
  log(`proxy stopped (profile: ${paths.profile})`);
}

async function statusFlow(opts = {}) {
  const homeDir = os.homedir();
  const paths = resolvePaths({ homeDir, profile: opts.profile, claudeSettingsPath: opts.claudeSettingsPath });
  const port = readPortFromProxyConfig(paths.configFile) ?? DEFAULT_PORT;
  const portOk = await proxyHealthcheck(port);

  log(`Profile: ${paths.profile}`);
  log(`Proxy: ${portOk ? "RUNNING" : "NOT RUNNING"} (http://127.0.0.1:${port})`);

  if (process.platform === "darwin") {
    const uid = getUid();
    log(`LaunchAgent: ${launchctlPrint(uid, paths.labelProxy) ? "loaded" : "not loaded"}`);
  }

  const auth = hasAuthFiles(paths.proxyDir);
  log(`Claude OAuth: ${auth.hasClaude ? "configured" : "not configured"}`);
  log(`Codex OAuth: ${auth.hasCodex ? "configured" : "not configured"}`);

  if (portOk) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Authorization: "Bearer sk-dummy" },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.ok) {
        const data = await res.json();
        const models = (data.data || []).map((m) => m.id).sort();
        log(`Models (${models.length}): ${models.join(", ")}`);
      }
    } catch {
      // ignore
    }
  }
}

async function uninstallFlow(opts = {}) {
  if (process.platform !== "darwin") fail("macOS only.");
  const homeDir = os.homedir();
  const username = getUsername();
  const uid = getUid();
  const paths = resolvePaths({ homeDir, profile: opts.profile, claudeSettingsPath: opts.claudeSettingsPath });

  // Stop our proxy and clean up legacy labels
  await stopExistingProxy(uid, paths.labelProxy);

  // Remove legacy plist files
  const legacyPlists = [
    `com.${username}.cli-proxy-api`,
    `com.${username}.cli-proxy-api-token-sync`,
    "com.cliproxyapi",
  ].map((l) => path.join(homeDir, "Library", "LaunchAgents", `${l}.plist`));

  for (const p of [...legacyPlists, paths.plistProxy]) {
    if (exists(p)) fs.rmSync(p, { force: true });
  }

  // Restore Claude Code settings
  if (opts.noGlobalSettings) {
    log("Skipping Claude Code settings cleanup (--no-global-settings).");
  } else {
    cleanupClaudeSettings({ claudeSettingsPath: paths.claudeSettingsPath });
  }

  if (opts.command === "purge") {
    if (exists(paths.proxyDir)) fs.rmSync(paths.proxyDir, { recursive: true, force: true });
    log(`purge completed for profile '${paths.profile}' (proxy files removed)`);
    return;
  }

  log(`uninstall completed for profile '${paths.profile}' (proxy files left in place)`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === "help") usage(0);

  try {
    switch (opts.command) {
      case "install":
        await installFlow(opts);
        break;
      case "claude-login":
        await oauthLoginFlow("claude", opts);
        break;
      case "codex-login":
        await oauthLoginFlow("codex", opts);
        break;
      case "start":
        await startFlow(opts);
        break;
      case "stop":
        await stopFlow(opts);
        break;
      case "status":
        await statusFlow(opts);
        break;
      case "uninstall":
        await uninstallFlow(opts);
        break;
      case "purge":
        await uninstallFlow(opts);
        break;
      default:
        usage(1);
    }
  } catch (e) {
    fail(e?.stack || String(e));
  }
}

await main();
