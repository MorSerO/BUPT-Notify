/**
 * setup.js — interactive first-run configuration ("npm run setup").
 *
 * Lets the user choose, inside the app:
 *   1) keep a local digest file only, or
 *   2) forward to a QQ mailbox (entering the SMTP authorisation code here), or
 *   3) both.
 * Writes config.json (git-ignored) and optionally verifies the credentials.
 */

import readline from 'node:readline/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, loadConfig } from './config.js';
import { verifyTransport } from './mailer.js';
import { readJson, writeJsonAtomic, ROOT } from './util.js';

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};

/**
 * Prompt without echoing (for the SMTP authorisation code).
 * Falls back to a normal prompt when stdin is not a TTY.
 */
function askHidden(question) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      rl.question(question).then((a) => {
        rl.close();
        resolve(a.trim());
      });
    });
  }

  return new Promise((resolve) => {
    stdout.write(question);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    let input = '';
    const finish = () => {
      stdin.setRawMode(wasRaw);
      stdin.removeListener('data', onData);
      stdin.pause();
      stdout.write('\n');
      resolve(input.trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') {
          stdout.write('\n已取消。\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          input = input.slice(0, -1);
          continue;
        }
        if (ch === '\u001b' || ch === '\t') continue; // ignore escape sequences
        input += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function isLikelyQQAuthCode(s) {
  // QQ authorisation codes are 16 lowercase letters; allow any 16 alphanumerics.
  return /^[A-Za-z0-9]{16}$/.test(String(s || '').replace(/\s+/g, ''));
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}

/**
 * Carry over only the fields that are actually part of the current schema.
 * Spreading the whole old object would drag in removed keys from older
 * versions of config.json (e.g. the former email.includeBody).
 */
function existingEmail(existing) {
  const e = existing?.email || {};
  return {
    host: e.host || 'smtp.qq.com',
    port: e.port || 465,
    secure: e.secure !== false,
    user: e.user && isEmail(e.user) ? e.user : '',
    pass: e.pass && !/授权码/.test(e.pass) ? e.pass : '',
    from: e.from || '',
    to: Array.isArray(e.to) ? e.to.filter(isEmail) : [],
    subjectPrefix: e.subjectPrefix || '[北邮通知]',
  };
}

/* ------------------------------------------------------- non-interactive -- */

function parseFlags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--help' || a === '-h') f.help = true;
    else if (a === '--mode') f.mode = val();
    else if (a === '--user') f.user = val();
    else if (a === '--pass') f.pass = val();
    else if (a === '--to') f.to = val();
    else if (a === '--local-dir') f.localDir = val();
    else if (a === '--window-days') f.windowDays = Number(val());
    else if (a === '--interval') f.interval = Number(val());
    else if (a === '--yes' || a === '-y') f.yes = true;
  }
  return f;
}

function printHelp() {
  console.log(`
BUPT-Notify 配置向导

  交互模式（推荐首次使用）:
      npm run setup

  非交互模式（适合脚本 / 自动化，需指定 --mode）:
      node src/setup.js --mode local
      node src/setup.js --mode email --user me@qq.com --pass <16位授权码> [--to a@b.com]
      node src/setup.js --mode both  --user me@qq.com --pass <授权码> --local-dir output

  参数:
      --mode <local|email|both>   获取方式（必填，用于非交互模式）
      --user <邮箱>                发件 QQ 邮箱
      --pass <授权码>              SMTP 授权码（16 位）
      --to   <邮箱[,邮箱]>         收件邮箱，默认与发件相同
      --local-dir <路径>           本地输出目录，默认 ./output
      --window-days <N>            只看最近 N 天，默认 10
      --interval <分钟>            轮询间隔，默认 120
      -y, --yes                    跳过确认，直接写入
`);
}

/** Build config.json entirely from flags, without prompting. */
function runNonInteractive(flags, existing) {
  const mode = flags.mode;
  if (!['local', 'email', 'both'].includes(mode)) {
    console.error(`--mode 必须是 local / email / both 之一（收到: ${mode}）`);
    return 1;
  }

  const email = existingEmail(existing);
  email.enabled = false;
  if (mode === 'email' || mode === 'both') {
    if (!flags.user || !isEmail(flags.user)) {
      console.error('缺少或非法的 --user（发件 QQ 邮箱），例如 --user 123456@qq.com');
      return 1;
    }
    if (!flags.pass) {
      console.error('缺少 --pass（QQ 邮箱 SMTP 16 位授权码）');
      return 1;
    }
    email.enabled = true;
    email.user = flags.user;
    email.pass = String(flags.pass).replace(/\s+/g, '');
    email.to = (flags.to || flags.user).split(/[,，;；\s]+/).filter(Boolean);
    email.from = email.from || email.user;
    email.subjectPrefix = email.subjectPrefix || '[北邮通知]';
    if (!isLikelyQQAuthCode(email.pass)) {
      console.warn(`警告: 授权码通常是 16 位字母，你给了 ${email.pass.length} 位，仍会写入。`);
    }
  } else {
    email.enabled = false;
  }

  const localDir = flags.localDir
    ? path.isAbsolute(flags.localDir)
      ? flags.localDir
      : path.join(ROOT, flags.localDir)
    : existing.output?.localDir || path.join(ROOT, 'output');

  const cfg = {
    baseUrl: existing.baseUrl || 'http://my.bupt.edu.cn/',
    targets: existing.targets || [
      { key: 'notice', name: '校内通知', treeId: '1154', path: 'list.jsp?urltype=tree.TreeTempUrl&wbtreeid=1154' },
      { key: 'document', name: '校内文件', treeId: '2001', path: 'list.jsp?urltype=tree.TreeTempUrl&wbtreeid=2001' },
    ],
    windowDays: flags.windowDays || existing.windowDays || 10,
    maxPages: existing.maxPages ?? 3,
    output: {
      mode,
      localDir,
      includeLink: existing.output?.includeLink !== false,
      includePublishDate: existing.output?.includePublishDate === true,
      includeSource: existing.output?.includeSource !== false,
    },
    email,
    poll: { intervalMinutes: flags.interval || existing.poll?.intervalMinutes || 120, jitterSeconds: 90 },
  };

  if (fs.existsSync(CONFIG_PATH)) {
    fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
  }
  writeJsonAtomic(CONFIG_PATH, cfg);
  console.log(`✓ 已写入 ${CONFIG_PATH}`);
  console.log(`  获取方式: ${mode === 'local' ? '仅本地文件' : mode === 'email' ? '仅邮件' : '本地文件 + 邮件'}`);
  if (mode !== 'email') console.log(`  本地目录: ${localDir}`);
  if (mode !== 'local') console.log(`  收件邮箱: ${email.to.join(', ')}`);
  console.log(`  时间窗口: 最近 ${cfg.windowDays} 天`);
  return 0;
}

async function main() {
  const existing = readJson(CONFIG_PATH, {}) || {};

  // Non-interactive path: usable from scripts and when stdin is not a TTY.
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return 0;
  }
  if (flags.mode) return runNonInteractive(flags, existing);
  if (!process.stdin.isTTY) {
    console.error(
      '检测到标准输入不是终端，交互向导无法提问。\n' +
        '请改用非交互模式，例如:\n' +
        '  node src/setup.js --mode local\n' +
        '  node src/setup.js --mode email --user 你的QQ@qq.com --pass 16位授权码\n' +
        '更多参数见: node src/setup.js --help',
    );
    return 1;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = async (q, def) => {
    const suffix = def !== undefined && def !== '' ? C.dim(` [${def}]`) : '';
    const a = (await rl.question(`${q}${suffix}: `)).trim();
    return a === '' && def !== undefined ? def : a;
  };

  console.log(`\n${C.b('BUPT-Notify 配置向导')}`);
  console.log(C.dim('北邮校内通知 / 校内文件 自动转发助手\n'));
  console.log('本向导会写入配置文件:');
  console.log(`  ${CONFIG_PATH}`);
  console.log(C.dim('（该文件已被 .gitignore 忽略，授权码不会外泄）\n'));

  /* ------------------------------ 1. mode ------------------------------ */
  console.log(C.b('第 1 步 / 选择获取方式'));
  console.log('  1) 只保存到本地文件  ——  不需要邮箱，内容写到本地 Markdown 文件');
  console.log('  2) 只发送到 QQ 邮箱  ——  需要 QQ 邮箱 SMTP 授权码');
  console.log('  3) 两者都要');
  let choice = await ask('请输入 1 / 2 / 3', existing.output?.mode === 'email' ? '2' : '1');
  if (!['1', '2', '3'].includes(choice)) {
    console.log(C.y('输入无效，默认选择 1（仅本地）。'));
    choice = '1';
  }
  const mode = { 1: 'local', 2: 'email', 3: 'both' }[choice];

  /* ------------------------------ 2. email ----------------------------- */
  const email = existingEmail(existing);
  let emailConfigured = false;

  if (mode === 'email' || mode === 'both') {
    console.log(`\n${C.b('第 2 步 / QQ 邮箱设置')}`);
    console.log(C.dim('需要先开启 SMTP 并生成授权码：'));
    console.log(C.dim('  QQ邮箱网页版 → 设置 → 账户 → POP3/IMAP/SMTP服务 → 开启 → 生成授权码'));
    console.log(C.y('  注意：填「授权码」（16 位字母），不是 QQ 登录密码。\n'));

    // Sender account
    let user = '';
    for (;;) {
      user = await ask('发件 QQ 邮箱地址', email.user || undefined);
      if (isEmail(user)) break;
      console.log(C.r('  邮箱格式不正确，请重新输入。'));
    }
    email.user = user;
    email.host = 'smtp.qq.com';
    email.port = 465;
    email.secure = true;
    email.enabled = true;

    const code = await askHidden('SMTP 授权码（输入时不显示）: ');
    if (!code) {
      console.log(C.r('未输入授权码，将无法发信。稍后可重新运行 npm run setup。'));
    } else if (!isLikelyQQAuthCode(code)) {
      console.log(C.y(`  提示: 授权码通常是 16 位字母，你输入了 ${code.length} 位字符，仍会保存。`));
    }
    email.pass = code.replace(/\s+/g, '');

    // Recipient(s)
    const to = await ask('收件邮箱（多个用逗号分隔，直接回车=发给自己）', email.to?.join(',') || user);
    email.to = to
      .split(/[,，;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!email.to.length) email.to = [user];

    email.from = email.from || email.user;
    email.subjectPrefix = email.subjectPrefix || '[北邮通知]';
    emailConfigured = true;
  } else {
    email.enabled = false;
  }

  /* ------------------------------ 3. local ----------------------------- */
  let localDir = existing.output?.localDir || path.join(ROOT, 'output');
  if (mode === 'local' || mode === 'both') {
    console.log(`\n${C.b('第 3 步 / 本地保存位置')}`);
    const d = await ask('本地输出目录', localDir);
    localDir = path.isAbsolute(d) ? d : path.join(ROOT, d);
  }

  /* --------------------------- 4. behaviour ---------------------------- */
  console.log(`\n${C.b('第 4 步 / 抓取设置')}`);
  const windowDays = Number(await ask('只看最近几天内的内容（天）', String(existing.windowDays ?? 10))) || 10;
  const intervalMinutes =
    Number(await ask('每隔多少分钟检查一次（开机时总会先跑一次）', String(existing.poll?.intervalMinutes ?? 120))) || 120;

  const cfg = {
    baseUrl: existing.baseUrl || 'http://my.bupt.edu.cn/',
    targets: existing.targets || [
      { key: 'notice', name: '校内通知', treeId: '1154', path: 'list.jsp?urltype=tree.TreeTempUrl&wbtreeid=1154' },
      { key: 'document', name: '校内文件', treeId: '2001', path: 'list.jsp?urltype=tree.TreeTempUrl&wbtreeid=2001' },
    ],
    windowDays,
    maxPages: existing.maxPages ?? 3,
    output: {
      mode,
      localDir,
      includeLink: existing.output?.includeLink !== false,
      includePublishDate: existing.output?.includePublishDate === true,
      includeSource: existing.output?.includeSource !== false,
    },
    email,
    poll: { intervalMinutes, jitterSeconds: existing.poll?.jitterSeconds ?? 90 },
  };

  /* ---------------------------- 5. confirm ----------------------------- */
  console.log(`\n${C.b('即将写入的配置')}`);
  console.log(`  获取方式   : ${mode === 'local' ? '仅本地文件' : mode === 'email' ? '仅邮件' : '本地文件 + 邮件'}`);
  if (mode !== 'email') console.log(`  本地目录   : ${localDir}`);
  if (emailConfigured) {
    console.log(`  发件邮箱   : ${email.user}`);
    console.log(`  授权码     : ${email.pass ? `${email.pass.length} 位（已输入）` : C.r('未输入')}`);
    console.log(`  收件邮箱   : ${email.to.join(', ')}`);
  }
  console.log(`  时间窗口   : 最近 ${windowDays} 天`);
  console.log(`  轮询间隔   : 每 ${intervalMinutes} 分钟`);

  const ok = (await ask('\n确认写入? (Y/n)', 'Y')).toLowerCase();
  if (ok === 'n' || ok === 'no') {
    console.log('已取消，未写入任何文件。');
    rl.close();
    return 0;
  }

  // Back up any existing config.
  if (fs.existsSync(CONFIG_PATH)) {
    const backup = `${CONFIG_PATH}.bak`;
    fs.copyFileSync(CONFIG_PATH, backup);
    console.log(C.dim(`已备份原配置到 ${path.basename(backup)}`));
  }
  writeJsonAtomic(CONFIG_PATH, cfg);
  console.log(C.g(`\n✓ 配置已写入 ${CONFIG_PATH}`));

  /* --------------------------- 6. verify SMTP -------------------------- */
  if (emailConfigured && email.pass) {
    const wantTest = (await ask('现在测试一下 SMTP 登录吗? (Y/n)', 'Y')).toLowerCase();
    if (wantTest !== 'n' && wantTest !== 'no') {
      process.stdout.write('正在验证 SMTP 登录… ');
      const merged = loadConfig({ quiet: true });
      const v = await verifyTransport(merged.email);
      if (v.ok) {
        console.log(C.g('成功 ✓'));
        console.log(C.dim('  授权码有效，可以正常发信。'));
      } else {
        console.log(C.r('失败 ✗'));
        console.log(C.r(`  ${v.error}`));
        console.log(
          C.y(
            '  常见原因：授权码不是 16 位 / SMTP 服务未开启 / 复制时带了空格。\n' +
              '  可重新运行 npm run setup 修改。',
          ),
        );
      }
    }
  }

  rl.close();

  console.log(`\n${C.b('下一步')}`);
  console.log(`  ${C.c('npm run doctor')}   自检（网络 / 邮箱 / 登录 / 配置）`);
  console.log(`  ${C.c('npm run once')}     立即运行一次`);
  console.log(`  ${C.c('npm start')}        开机模式：先跑一次，之后按间隔轮询`);
  console.log(`  ${C.c('npm run autostart')} 安装开机自启\n`);
  return 0;
}

/** Only run the wizard when executed directly, not when imported. */
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    console.error(`\n配置向导出错: ${err.message}`);
    process.exit(1);
  });
}

