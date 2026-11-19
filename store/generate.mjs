// Builds the Chrome Web Store images from the real extension:
//   node store/generate.mjs
// Output: store/images/<ja|en>/screenshot-*.png (1280x800), promo-small.png (440x280),
//         store/images/store-icon-128.png
// Uses the Playwright devDependency; not part of the extension package.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const outRoot = path.join(here, 'images');
const PORT = 41990;
const HOST = 'app.example.com';
const SITE = `http://${HOST}:${PORT}/`;
const GROUP = 'example.com';
const GROUP_HOST = 'www.example.com';
const GROUP_SITE = `http://${GROUP_HOST}:${PORT}/`;
const RUNTIME = ['manifest.json', '_locales', 'background', 'content', 'icons', 'lib', 'options', 'popup'];

const TEXT = {
  ja: {
    names: ['管理者（山田）', '一般ユーザー（佐藤）', '閲覧のみ（ゲスト）', '未ログイン'],
    memos: ['請求まわりの確認用', '', '権限の制限を確かめる', ''],
    groupNames: ['公開サイト（会員）', '公開サイト（未ログイン）'],
    shots: [
      ['ログイン状態をワンクリックで切り替え', 'サイトごとに Cookie・localStorage・sessionStorage・IndexedDB を名前を付けて保存'],
      ['切り替え前の状態にすぐ戻せる', '読み込む直前の状態を自動で残すので、間違えても「戻す」で元どおり'],
      ['あとから変わったら知らせる', '適用中のスナップショットと比べて「変更あり」を表示。何が変わったかもわかる'],
      ['サブドメインをまとめて切り替え', 'example.com と *.example.com の Cookie をグループで保存・切り替え。ほかのサブドメインで保存したものも並ぶ'],
    ],
    options: ['使用量とデータの管理', 'どのサイトが大きいかを一目で。パスフレーズで暗号化したエクスポートにも対応'],
    tagline: 'ログイン状態をワンクリックで切り替え',
  },
  en: {
    names: ['Admin (Alex)', 'Member (Sam)', 'Viewer (Guest)', 'Signed out'],
    memos: ['For checking billing', '', 'Tests the restricted role', ''],
    groupNames: ['Public site (member)', 'Public site (signed out)'],
    shots: [
      ['Switch sign-ins in one click', 'Save cookies, localStorage, sessionStorage and IndexedDB per site, by name'],
      ['Undo a switch right away', 'The state before each load is kept, so Restore brings it back'],
      ['Know when things changed', 'Compares with the active snapshot and shows what changed'],
      ['Switch subdomains together', 'Group example.com and *.example.com to save and switch their cookies as one; snapshots from other subdomains are listed too'],
    ],
    options: ['See usage and manage your data', 'Spot the largest sites at a glance, and export with passphrase encryption'],
    tagline: 'Switch sign-ins in one click',
  },
};

function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, SITE);
    if (url.pathname === '/login') {
      res.writeHead(302, { 'Set-Cookie': `sid=${url.searchParams.get('user')}; Path=/; HttpOnly`, Location: '/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Example App</title><h1>Example App</h1>');
  });
  return new Promise(resolve => server.listen(PORT, () => resolve(server)));
}

function extensionCopy() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tk3-store-'));
  for (const e of RUNTIME) cpSync(path.join(repoRoot, e), path.join(dir, e), { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  manifest.host_permissions = ['<all_urls>'];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return dir;
}

async function launch(extDir) {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    deviceScaleFactor: 2,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      `--host-resolver-rules=MAP *.${GROUP} 127.0.0.1`,
      '--no-first-run',
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return { context, id: new URL(sw.url()).host };
}

async function openPopup(context, id, site) {
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 320, height: POPUP_MAX });
  await popup.addStyleTag({ content: NO_SCROLLBARS }).catch(() => {});
  await popup.addInitScript(url => {
    const query = chrome.tabs.query;
    chrome.tabs.query = async info => {
      if (info.active && info.currentWindow) {
        const match = (await query({})).find(t => t.url === url);
        if (match) return [match];
      }
      return query(info);
    };
  }, site.url());
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  await popup.locator('body[data-ready="true"]').waitFor();
  await popup.addStyleTag({ content: NO_SCROLLBARS });
  return popup;
}

const POPUP_MAX = 600;
const OPTIONS_WIDTH = 920;
const OPTIONS_MAX_HEIGHT = 1000;
const NO_SCROLLBARS = 'html { scrollbar-width: none; } ::-webkit-scrollbar { display: none; }';

async function capturePopup(popup) {
  const height = await popup.evaluate(() => {
    const bottoms = [document.querySelector('.container').getBoundingClientRect().bottom];
    for (const menu of document.querySelectorAll('[popover]')) {
      if (menu.matches(':popover-open')) bottoms.push(menu.getBoundingClientRect().bottom);
    }
    return Math.ceil(Math.max(...bottoms) + 12);
  });
  return popup.screenshot({ clip: { x: 0, y: 0, width: 320, height: Math.min(height, POPUP_MAX) } });
}

const minutesAgo = m => new Date(Date.now() - m * 60_000).toISOString();
const sidCookie = user => ({ name: 'sid', value: user, domain: HOST, path: '/', secure: false, httpOnly: true, sameSite: 'lax' });

const COLORS = ['blue', 'green', 'amber', null];
const appSettings = user => JSON.stringify({ theme: 'light', recent: user ? ['dashboard', 'invoices', 'reports'] : [] });

async function seed(page, lang, { active, backup, group = false }) {
  const { names, memos, groupNames } = TEXT[lang];
  const users = ['yamada', 'sato', 'guest', ''];
  const ages = [60 * 26, 60 * 24 * 3, 60 * 24 * 12, 60 * 24 * 40];
  const snapshots = {
    [HOST]: Object.fromEntries(names.map((n, i) => [n, {
      savedAt: minutesAgo(ages[i]),
      ...(memos[i] && { memo: memos[i] }),
      ...(COLORS[i] && { color: COLORS[i] }),
      cookies: users[i] ? [sidCookie(users[i])] : [],
      localStorage: { user: users[i], settings: appSettings(users[i]) },
      sessionStorage: users[i] ? { tab: 'main' } : {},
    }])),
  };
  const snapshotOrder = { [HOST]: names };
  if (group) {
    snapshots[GROUP_HOST] = Object.fromEntries(groupNames.map((n, i) => [n, {
      savedAt: minutesAgo(60 * (5 + i * 30)),
      ...(i === 0 && { color: 'green' }),
      cookieDomain: GROUP,
      cookies: [],
      localStorage: { cart: i === 0 ? '3' : '0' },
    }]));
    snapshotOrder[GROUP_HOST] = groupNames;
  }
  let activeSnapshots = {};
  if (active) activeSnapshots = group ? { [GROUP]: { host: HOST, name: active } } : { [HOST]: active };
  const backups = backup ? { [HOST]: { savedAt: backup, activeName: null, cookies: [], localStorage: {} } } : {};
  const groups = group ? [GROUP] : [];
  await page.evaluate(async data => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set(data);
  }, { language: lang, snapshots, snapshotOrder, activeSnapshots, backups, groups });
}

async function signIn(site, user, origin = SITE) {
  await site.goto(`${origin}login?user=${user}`);
  await site.evaluate(u => localStorage.setItem('user', u), user);
}

async function popupScenes(context, id, lang) {
  const site = await context.newPage();
  const names = TEXT[lang].names;
  const shots = [];
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${id}/options/options.html`);

  // 1. The list, first snapshot active and unchanged.
  await signIn(site, 'yamada');
  await seed(settings, lang, { active: names[0] });
  let popup = await openPopup(context, id, site);
  await popup.waitForTimeout(800);
  shots.push(await capturePopup(popup));
  await popup.close();

  // 2. Right after loading another snapshot: status and the undo bar.
  await seed(settings, lang, { active: names[0] });
  popup = await openPopup(context, id, site);
  await popup.locator('.snapshot__main').nth(1).click();
  await popup.locator('#statusMsg.success').waitFor();
  await popup.mouse.move(0, 0);
  await popup.waitForTimeout(400);
  shots.push(await capturePopup(popup));
  await popup.close();

  // 3. The active snapshot changed since (signed in as someone else), menu open.
  await signIn(site, 'guest');
  await seed(settings, lang, { active: names[0], backup: minutesAgo(12) });
  popup = await openPopup(context, id, site);
  await popup.locator('.badge--modified').first().waitFor({ state: 'visible' });
  await popup.locator('.badge--modified').first().click();
  await popup.waitForTimeout(400);
  shots.push(await capturePopup(popup));
  await popup.close();

  // 4. A subdomain group: on www, the snapshots saved on app are listed too.
  await signIn(site, 'yamada');
  await signIn(site, 'member', GROUP_SITE);
  await seed(settings, lang, { active: names[0], group: true });
  popup = await openPopup(context, id, site);
  await popup.locator('#groupChip:not(.hidden)').waitFor();
  await popup.waitForTimeout(800);
  shots.push(await capturePopup(popup));
  await popup.close();

  // 5. The options page: storage meter, groups and the domain list.
  await settings.setViewportSize({ width: OPTIONS_WIDTH, height: 1100 });
  await settings.goto(`chrome-extension://${id}/options/options.html#snapshots`);
  await settings.reload();
  await settings.locator('body[data-ready="true"]').waitFor();
  await settings.locator('#meterTotal:not(:empty)').waitFor();
  await settings.addStyleTag({ content: NO_SCROLLBARS });
  await settings.waitForTimeout(400);
  const optionsBottom = await settings.evaluate(() =>
    document.getElementById('domainList').closest('.section').getBoundingClientRect().bottom);
  const optionsHeight = Math.min(Math.ceil(optionsBottom + 8), OPTIONS_MAX_HEIGHT);
  const optionsShot = await settings.screenshot({ clip: { x: 0, y: 0, width: OPTIONS_WIDTH, height: optionsHeight } });

  await site.close();
  await settings.close();
  return { shots, optionsShot };
}

const iconSvg = readFileSync(path.join(repoRoot, 'icons/icon.svg'), 'utf-8');
const dataUrl = png => `data:image/png;base64,${png.toString('base64')}`;
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const BASE_CSS = `
  * { margin: 0; box-sizing: border-box; }
  body { font-family: system-ui, 'Segoe UI', 'Yu Gothic UI', 'Hiragino Sans', Meiryo, sans-serif; color: #1B1C20; background: #F6F7F9; }
  .brand { display: flex; align-items: center; gap: 12px; font-weight: 700; letter-spacing: .02em; }
  .brand svg { width: 40px; height: 40px; }
`;

function screenshotHtml({ title, sub, image, imageWidth, wide, lang }) {
  return `<!doctype html><html lang="${lang}"><meta charset="utf-8"><style>${BASE_CSS}
    body { width: 1280px; height: 800px; display: grid; grid-template-columns: ${wide ? '400px 1fr' : '1fr 470px'}; gap: 56px; align-items: center; padding: 0 88px; overflow: hidden; }
    .copy { display: flex; flex-direction: column; gap: 22px; }
    .brand { font-size: 18px; color: #44474F; }
    h1 { font-size: ${wide ? 40 : 48}px; line-height: 1.3; font-weight: 700; word-break: auto-phrase; text-wrap: balance; }
    p { font-size: 22px; line-height: 1.6; color: #44474F; word-break: auto-phrase; text-wrap: pretty; }
    .shot { justify-self: center; width: ${imageWidth}px; border-radius: 16px; overflow: hidden; border: 1px solid #D9DCE3;
            box-shadow: 0 2px 6px rgb(0 0 0 / .06), 0 24px 60px rgb(31 99 216 / .16); background: #fff; }
    .shot img { display: block; width: 100%; }
  </style>
  <div class="copy"><div class="brand">${iconSvg}SWITCH BROWSER DATA</div><h1>${esc(title)}</h1><p>${esc(sub)}</p></div>
  <div class="shot"><img src="${dataUrl(image)}"></div>`;
}

function promoHtml(tagline) {
  return `<!doctype html><meta charset="utf-8"><style>${BASE_CSS}
    body { width: 440px; height: 280px; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 18px; background: #FFFFFF; }
    .icon svg { width: 96px; height: 96px; display: block; }
    .name { font-size: 24px; font-weight: 700; letter-spacing: .03em; }
    .tag { font-size: 17px; color: #44474F; }
  </style>
  <div class="icon">${iconSvg}</div><div class="name">SWITCH BROWSER DATA</div><div class="tag">${esc(tagline)}</div>`;
}

// 96x96 artwork inside 16px of transparent padding, as the store asks.
const storeIconHtml = `<!doctype html><style>html,body{margin:0;background:transparent}div{width:128px;height:128px;display:grid;place-items:center}svg{width:96px;height:96px}</style><div>${iconSvg}</div>`;

async function render(browserContext, html, width, height, file, transparent = false) {
  const page = await browserContext.newPage();
  await page.setViewportSize({ width, height });
  await page.setContent(html);
  await page.screenshot({ path: file, omitBackground: transparent });
  await page.close();
}

const server = await startServer();
const extDir = extensionCopy();
const { context, id } = await launch(extDir);
const renderer = await chromium.launch();
const renderContext = await renderer.newContext({ deviceScaleFactor: 1 });
try {
  rmSync(outRoot, { recursive: true, force: true });
  for (const lang of ['ja', 'en']) {
    const dir = path.join(outRoot, lang);
    mkdirSync(dir, { recursive: true });
    const { shots, optionsShot } = await popupScenes(context, id, lang);
    for (const [i, image] of shots.entries()) {
      const [title, sub] = TEXT[lang].shots[i];
      await render(renderContext, screenshotHtml({ title, sub, image, imageWidth: 430, lang }), 1280, 800, path.join(dir, `screenshot-${i + 1}.png`));
    }
    const [title, sub] = TEXT[lang].options;
    await render(renderContext, screenshotHtml({ title, sub, image: optionsShot, imageWidth: 640, wide: true, lang }), 1280, 800, path.join(dir, 'screenshot-5.png'));
    await render(renderContext, promoHtml(TEXT[lang].tagline), 440, 280, path.join(dir, 'promo-small.png'));
  }
  await render(renderContext, storeIconHtml, 128, 128, path.join(outRoot, 'store-icon-128.png'), true);
  console.log(`Wrote ${outRoot}`);
} finally {
  await context.close();
  await renderer.close();
  server.close();
  rmSync(extDir, { recursive: true, force: true });
}
