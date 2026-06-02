#!/usr/bin/env node
/**
 * Script khởi động DS2API - menu tương tác
 *
 * Cách dùng:
 *   node start.mjs          # Hiển thị menu tương tác
 *   node start.mjs dev      # Chế độ dev (backend + frontend hot reload)
 *   node start.mjs prod     # Chế độ production (chạy sau khi build)
 *   node start.mjs build    # Biên dịch binary backend
 *   node start.mjs webui    # Build file tĩnh frontend
 *   node start.mjs install  # Cài dependency frontend
 *   node start.mjs stop     # Dừng tất cả dịch vụ
 *   node start.mjs status   # Xem trạng thái dịch vụ
 */

import { spawn, execSync } from 'child_process';
import { createInterface } from 'readline';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Kiểm tra có phải Windows không
const isWindows = process.platform === 'win32';

// Đường dẫn artifact build
const BINARY = join(__dirname, isWindows ? 'ds2api.exe' : 'ds2api');

// Cấu hình (đọc từ biến môi trường, đồng bộ với chương trình Go chính)
const CONFIG = {
  port: process.env.PORT || '5001',
  frontendPort: 5173,
  logLevel: process.env.LOG_LEVEL || 'INFO',
  adminKey: process.env.DS2API_ADMIN_KEY || 'admin',
  webuiDir: join(__dirname, 'webui'),
  staticAdminDir: process.env.DS2API_STATIC_ADMIN_DIR || join(__dirname, 'static', 'admin'),
};

// Cấu hình mirror
const MIRRORS = {
  goproxy: process.env.GOPROXY || 'https://goproxy.cn,direct',
  npm: process.env.NPM_REGISTRY || 'https://registry.npmmirror.com',
};

// Lưu tiến trình con
const processes = [];

// Màu output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

const log = {
  info: (msg) => console.log(`${colors.cyan}[INFO]${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}[OK]${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}[WARN]${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}[ERROR]${colors.reset} ${msg}`),
  title: (msg) => console.log(`\n${colors.bright}${colors.magenta}${msg}${colors.reset}`),
};

// Dọn dẹp và thoát
function cleanup() {
  console.log('\n');
  log.info('Đang tắt tất cả dịch vụ...');
  processes.forEach(proc => {
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
    }
  });
  log.success('Đã thoát');
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Kiểm tra command có tồn tại không
function commandExists(cmd) {
  try {
    execSync(`${isWindows ? 'where' : 'which'} ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Kiểm tra Go đã được cài chưa
function checkGo() {
  return commandExists('go');
}

// Lấy phiên bản Go
function getGoVersion() {
  try {
    return execSync('go version', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

// Kiểm tra dependency frontend đã được cài chưa
function checkFrontendDeps() {
  if (!existsSync(CONFIG.webuiDir)) return null;
  return existsSync(join(CONFIG.webuiDir, 'node_modules'));
}

// Kiểm tra frontend đã build chưa
function checkWebuiBuilt() {
  return existsSync(join(CONFIG.staticAdminDir, 'index.html'));
}

// Kiểm tra binary backend có tồn tại không
function binaryExists() {
  return existsSync(BINARY);
}

// Tìm PID tiến trình đang chiếm cổng
function findPidByPort(port) {
  const numericPort = parseInt(port, 10);
  if (isNaN(numericPort)) return [];

  try {
    if (isWindows) {
      const output = execSync(`netstat -ano | findstr :${numericPort} | findstr LISTENING`, {
        encoding: 'utf-8',
        shell: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const pids = new Set();
      for (const line of output.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0') pids.add(pid);
      }
      return [...pids];
    } else {
      const output = execSync(`lsof -ti :${numericPort}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return output.trim().split('\n').filter(Boolean);
    }
  } catch {
    return [];
  }
}

// Lấy trạng thái các dịch vụ đang chạy
function getRunningStatus() {
  const backendPids = findPidByPort(CONFIG.port);
  const frontendPids = findPidByPort(CONFIG.frontendPort);
  return {
    backend: backendPids,
    frontend: frontendPids,
    isRunning: backendPids.length > 0 || frontendPids.length > 0,
  };
}

// Dừng dịch vụ
async function stopServices() {
  const running = getRunningStatus();

  if (!running.isRunning) {
    log.warn('Không phát hiện dịch vụ nào đang chạy');
    return;
  }

  log.title('========== Dừng dịch vụ ==========');

  const killProcess = async (pid) => {
    try {
      if (isWindows) {
        try {
          execSync(`taskkill /PID ${pid}`, { stdio: 'ignore', shell: true });
        } catch {
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', shell: true });
        }
      } else {
        execSync(`kill -15 ${pid}`, { stdio: 'ignore' });
        await new Promise(r => setTimeout(r, 500));
        try {
          execSync(`kill -0 ${pid}`, { stdio: 'ignore' });
          execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
        } catch { /* Tiến trình đã thoát */ }
      }
    } catch { /* Tiến trình có thể đã thoát */ }
  };

  if (running.backend.length > 0) {
    log.info(`Đang dừng dịch vụ backend (cổng ${CONFIG.port}, PID: ${running.backend.join(', ')})...`);
    for (const pid of running.backend) await killProcess(pid);
    log.success('Đã dừng dịch vụ backend');
  }

  if (running.frontend.length > 0) {
    log.info(`Đang dừng dịch vụ frontend (cổng ${CONFIG.frontendPort}, PID: ${running.frontend.join(', ')})...`);
    for (const pid of running.frontend) await killProcess(pid);
    log.success('Đã dừng dịch vụ frontend');
  }
}

// Cài dependency frontend
async function installFrontendDeps() {
  if (!existsSync(CONFIG.webuiDir)) {
    log.warn('Không có thư mục webui, bỏ qua cài dependency frontend');
    return;
  }
  log.info(`Đang cài dependency frontend (npm ci, registry: ${MIRRORS.npm})...`);
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', ['ci', '--registry', MIRRORS.npm], {
      cwd: CONFIG.webuiDir,
      stdio: 'inherit',
      shell: isWindows,
    });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error('Cài dependency frontend thất bại')));
  });
}

// Đảm bảo dependency frontend đã được cài
async function ensureFrontendDeps() {
  if (checkFrontendDeps() === false) {
    log.warn('Phát hiện dependency frontend chưa được cài, đang cài đặt...');
    await installFrontendDeps();
  }
}

// Biên dịch binary backend
async function buildBackend() {
  if (!checkGo()) throw new Error('Không tìm thấy Go, vui lòng cài Go trước (https://go.dev/dl/)');
  log.info(`Đang biên dịch binary backend (GOPROXY: ${MIRRORS.goproxy})...`);
  return new Promise((resolve, reject) => {
    const proc = spawn('go', ['build', '-o', BINARY, './cmd/ds2api'], {
      cwd: __dirname,
      stdio: 'inherit',
      shell: isWindows,
      env: { ...process.env, GOPROXY: MIRRORS.goproxy },
    });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error('Biên dịch backend thất bại')));
  });
}

// Build file tĩnh frontend
async function buildWebui() {
  if (!existsSync(CONFIG.webuiDir)) {
    log.warn('Không có thư mục webui');
    return;
  }
  await ensureFrontendDeps();
  log.info('Đang build file tĩnh frontend...');
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'npm', ['run', 'build', '--', '--outDir', CONFIG.staticAdminDir, '--emptyOutDir'],
      { cwd: CONFIG.webuiDir, stdio: 'inherit', shell: isWindows }
    );
    proc.on('close', code => code === 0 ? resolve() : reject(new Error('Build frontend thất bại')));
  });
}

// Khởi động backend (chế độ dev: go run, không cần biên dịch trước)
async function startBackendDev() {
  if (!checkGo()) throw new Error('Không tìm thấy Go, vui lòng cài Go trước (https://go.dev/dl/)');
  log.info(`Đang khởi động backend (go run)... Local http://127.0.0.1:${CONFIG.port}  bind 0.0.0.0:${CONFIG.port}`);
  const proc = spawn('go', ['run', './cmd/ds2api'], {
    cwd: __dirname,
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env,
      PORT: CONFIG.port,
      LOG_LEVEL: CONFIG.logLevel,
      DS2API_ADMIN_KEY: CONFIG.adminKey,
      GOPROXY: MIRRORS.goproxy,
    },
  });
  processes.push(proc);
  return proc;
}

// Khởi động backend (chế độ production: chạy binary đã biên dịch)
async function startBackendProd() {
  if (!binaryExists()) {
    log.warn('Không tìm thấy artifact build, đang biên dịch...');
    await buildBackend();
  }
  log.info(`Đang khởi động backend (binary)... Local http://127.0.0.1:${CONFIG.port}  bind 0.0.0.0:${CONFIG.port}`);
  const proc = spawn(BINARY, [], {
    cwd: __dirname,
    stdio: 'inherit',
    shell: false,
    env: {
      ...process.env,
      PORT: CONFIG.port,
      LOG_LEVEL: CONFIG.logLevel,
      DS2API_ADMIN_KEY: CONFIG.adminKey,
    },
  });
  processes.push(proc);
  return proc;
}

// Khởi động server dev frontend
async function startFrontend() {
  if (!existsSync(CONFIG.webuiDir)) {
    log.warn('Không có thư mục webui, bỏ qua khởi động frontend');
    return null;
  }
  await ensureFrontendDeps();
  log.info(`Đang khởi động server dev frontend... http://localhost:${CONFIG.frontendPort}`);
  const proc = spawn('npm', ['run', 'dev'], {
    cwd: CONFIG.webuiDir,
    stdio: 'inherit',
    shell: true,
  });
  processes.push(proc);
  return proc;
}

// Hiển thị thông tin trạng thái
function showStatus() {
  console.log('\n' + '─'.repeat(50));
  log.success(`Backend API:  http://127.0.0.1:${CONFIG.port}`);
  log.success(`Giao diện quản trị: http://127.0.0.1:${CONFIG.port}/admin`);
  log.info(`Backend bind:  0.0.0.0:${CONFIG.port} (có thể truy cập qua IP LAN)`);
  if (existsSync(CONFIG.webuiDir)) {
    log.success(`Frontend Dev:  http://localhost:${CONFIG.frontendPort}`);
  }
  console.log('─'.repeat(50));
  log.info('Nhấn Ctrl+C để dừng tất cả dịch vụ\n');
}

// Chờ các tiến trình thoát
function waitForProcesses() {
  return new Promise(resolve => {
    const check = setInterval(() => {
      const activeCount = processes.filter(proc => proc.exitCode === null && proc.signalCode === null).length;
      if (activeCount === 0) {
        clearInterval(check);
        resolve();
      }
    }, 1000);
  });
}

// Menu tương tác
async function showMenu() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

  console.clear();
  log.title('╔══════════════════════════════════════════╗');
  log.title('║       Script khởi động DS2API (Go)       ║');
  log.title('╚══════════════════════════════════════════╝');

  // Trạng thái môi trường
  const goVersion = getGoVersion();
  const frontendDeps = checkFrontendDeps();
  const webuiBuilt = checkWebuiBuilt();
  const hasBinary = binaryExists();
  const running = getRunningStatus();

  const ok = (v) => v ? `${colors.green}✓${colors.reset}` : `${colors.yellow}✗${colors.reset}`;

  console.log(`\n${colors.bright}Trạng thái môi trường:${colors.reset}`);
  console.log(`  Go:             ${goVersion ? `${colors.green}${goVersion}${colors.reset}` : `${colors.red}Chưa cài${colors.reset}`}`);
  console.log(`  Dependency FE:  ${frontendDeps === null ? `${colors.dim}N/A${colors.reset}` : frontendDeps ? `${colors.green}Đã cài${colors.reset}` : `${colors.yellow}Chưa cài${colors.reset}`}`);
  console.log(`  Build FE:       ${ok(webuiBuilt)} ${webuiBuilt ? `(${CONFIG.staticAdminDir})` : 'Chưa build'}`);
  console.log(`  Binary backend: ${ok(hasBinary)} ${hasBinary ? BINARY : 'Chưa biên dịch'}`);

  console.log(`\n${colors.bright}Trạng thái dịch vụ:${colors.reset}`);
  console.log(`  Backend (:${CONFIG.port}):    ${running.backend.length > 0 ? `${colors.green}Đang chạy${colors.reset} (PID: ${running.backend.join(', ')})` : `${colors.dim}Chưa chạy${colors.reset}`}`);
  console.log(`  Frontend (:${CONFIG.frontendPort}): ${running.frontend.length > 0 ? `${colors.green}Đang chạy${colors.reset} (PID: ${running.frontend.join(', ')})` : `${colors.dim}Chưa chạy${colors.reset}`}`);

  console.log(`\n${colors.bright}Biến môi trường:${colors.reset}`);
  console.log(`  PORT:              ${colors.cyan}${CONFIG.port}${colors.reset}`);
  console.log(`  LOG_LEVEL:         ${colors.cyan}${CONFIG.logLevel}${colors.reset}`);
  console.log(`  DS2API_ADMIN_KEY:  ${colors.cyan}${CONFIG.adminKey}${colors.reset}`);
  console.log(`  GOPROXY:           ${colors.cyan}${MIRRORS.goproxy}${colors.reset}`);
  console.log(`  NPM_REGISTRY:      ${colors.cyan}${MIRRORS.npm}${colors.reset}`);
  console.log(`${colors.dim}  Tùy chỉnh: DS2API_ADMIN_KEY=secret PORT=5001 node start.mjs${colors.reset}`);

  console.log(`
${colors.bright}Vui lòng chọn thao tác:${colors.reset}

  ${colors.cyan}1.${colors.reset} Chế độ dev        (go run + frontend hot reload)
  ${colors.cyan}2.${colors.reset} Chỉ backend       (go run, không cần biên dịch)
  ${colors.cyan}3.${colors.reset} Chỉ frontend      (npm dev)
  ${colors.cyan}4.${colors.reset} Chế độ production (chạy sau khi biên dịch, frontend đã nhúng)
  ${colors.cyan}5.${colors.reset} Biên dịch backend (go build)
  ${colors.cyan}6.${colors.reset} Build frontend    (npm build → static/admin)
  ${colors.cyan}7.${colors.reset} Cài dependency FE (npm ci)
  ${colors.red}8.${colors.reset} Dừng tất cả dịch vụ
  ${colors.cyan}0.${colors.reset} Thoát
`);

  const choice = await question(`${colors.yellow}Nhập lựa chọn [1]: ${colors.reset}`);
  rl.close();

  switch (choice.trim() || '1') {
    case '1':
      log.title('========== Chế độ dev ==========');
      await startBackendDev();
      await new Promise(r => setTimeout(r, 1500));
      await startFrontend();
      showStatus();
      await waitForProcesses();
      break;

    case '2':
      log.title('========== Chỉ backend (go run) ==========');
      await startBackendDev();
      showStatus();
      await waitForProcesses();
      break;

    case '3':
      log.title('========== Chỉ frontend ==========');
      await startFrontend();
      showStatus();
      await waitForProcesses();
      break;

    case '4':
      log.title('========== Chế độ production ==========');
      await startBackendProd();
      showStatus();
      await waitForProcesses();
      break;

    case '5':
      log.title('========== Biên dịch backend ==========');
      await buildBackend();
      log.success(`Biên dịch hoàn tất: ${BINARY}`);
      break;

    case '6':
      log.title('========== Build frontend ==========');
      await buildWebui();
      log.success('Build frontend hoàn tất!');
      break;

    case '7':
      log.title('========== Cài dependency frontend ==========');
      await installFrontendDeps();
      log.success('Cài dependency frontend hoàn tất!');
      break;

    case '8':
      await stopServices();
      break;

    case '0':
      log.info('Tạm biệt!');
      process.exit(0);
      break;

    default:
      log.warn('Lựa chọn không hợp lệ');
      await showMenu();
  }
}

// Xử lý tham số dòng lệnh
async function main() {
  const cmd = process.argv[2];

  if (!checkGo() && !['install', 'webui', 'stop', 'status', 'help', '-h', '--help'].includes(cmd)) {
    log.error('Không tìm thấy Go, vui lòng cài Go trước: https://go.dev/dl/');
    if (!cmd) {
      // Khi không có Go, vẫn cho vào menu (có thể chỉ thao tác frontend)
    } else {
      process.exit(1);
    }
  }

  switch (cmd) {
    case 'dev':
      log.title('========== Chế độ dev ==========');
      await startBackendDev();
      await new Promise(r => setTimeout(r, 1500));
      await startFrontend();
      showStatus();
      await waitForProcesses();
      break;

    case 'prod':
      log.title('========== Chế độ production ==========');
      await startBackendProd();
      showStatus();
      await waitForProcesses();
      break;

    case 'build':
      await buildBackend();
      log.success(`Biên dịch hoàn tất: ${BINARY}`);
      break;

    case 'webui':
      await buildWebui();
      log.success('Build frontend hoàn tất!');
      break;

    case 'install':
      await installFrontendDeps();
      log.success('Cài dependency frontend hoàn tất!');
      break;

    case 'stop':
      await stopServices();
      break;

    case 'status': {
      const status = getRunningStatus();
      const goVer = getGoVersion();
      console.log(`\n${colors.bright}Môi trường:${colors.reset}`);
      console.log(`  Go: ${goVer || `${colors.red}Chưa cài${colors.reset}`}`);
      console.log(`\n${colors.bright}Trạng thái dịch vụ:${colors.reset}`);
      console.log(`  Backend (:${CONFIG.port}):    ${status.backend.length > 0 ? `${colors.green}Đang chạy${colors.reset} (PID: ${status.backend.join(', ')})` : `${colors.dim}Chưa chạy${colors.reset}`}`);
      console.log(`  Frontend (:${CONFIG.frontendPort}): ${status.frontend.length > 0 ? `${colors.green}Đang chạy${colors.reset} (PID: ${status.frontend.join(', ')})` : `${colors.dim}Chưa chạy${colors.reset}`}\n`);
      break;
    }

    case 'help':
    case '-h':
    case '--help':
      console.log(`
${colors.bright}Script khởi động DS2API (Go)${colors.reset}

${colors.cyan}Cách dùng:${colors.reset}
  node start.mjs              Hiển thị menu tương tác
  node start.mjs dev          Chế độ dev (go run + frontend hot reload)
  node start.mjs prod         Chế độ production (artifact đã biên dịch, frontend đã nhúng)
  node start.mjs build        Biên dịch binary backend (go build)
  node start.mjs webui        Build file tĩnh frontend
  node start.mjs install      Cài dependency frontend (npm ci)
  node start.mjs stop         Dừng tất cả dịch vụ
  node start.mjs status       Xem trạng thái dịch vụ

${colors.cyan}Biến môi trường thường dùng:${colors.reset}
  PORT               Cổng backend (mặc định: 5001)
  LOG_LEVEL          Cấp độ log: DEBUG|INFO|WARN|ERROR (mặc định: INFO)
  DS2API_ADMIN_KEY   Khóa quản trị (mặc định: admin)
  DS2API_CONFIG_PATH Đường dẫn file cấu hình (mặc định: config.json)
  GOPROXY            Go module proxy (mặc định: https://goproxy.cn,direct)
  NPM_REGISTRY       npm registry (mặc định: https://registry.npmmirror.com)

${colors.cyan}Ví dụ:${colors.reset}
  DS2API_ADMIN_KEY=mykey PORT=8080 node start.mjs dev
  GOPROXY=off NPM_REGISTRY=https://registry.npmjs.org node start.mjs dev
`);
      break;

    default:
      await showMenu();
  }
}

main().catch(e => {
  log.error(e.message);
  process.exit(1);
});
