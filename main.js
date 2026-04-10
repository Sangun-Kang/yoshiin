const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, clipboard, globalShortcut, systemPreferences } = require('electron');
const fs = require('fs');
const path = require('path');

let keybd_event;
let CGEventCreateKeyboardEvent;
let CGEventSetFlags;
let CGEventPost;
let CFRelease;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    keybd_event = user32.func(
      'void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)'
    );
  } catch (error) {
    console.warn('yoshiin: Windows key injection is unavailable:', error.message);
  }
} else if (process.platform === 'darwin') {
  try {
    const koffi = require('koffi');
    const coreGraphics = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
    const coreFoundation = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
    CGEventCreateKeyboardEvent = coreGraphics.func('void* CGEventCreateKeyboardEvent(void* source, uint16_t virtualKey, bool keyDown)');
    CGEventSetFlags = coreGraphics.func('void CGEventSetFlags(void* event, uint64_t flags)');
    CGEventPost = coreGraphics.func('void CGEventPost(uint32_t tap, void* event)');
    CFRelease = coreFoundation.func('void CFRelease(void* cf)');
  } catch (error) {
    console.warn('yoshiin: macOS key injection is unavailable:', error.message);
  }
}

const VK_CONTROL = 0x11;
const VK_RETURN = 0x0d;
const VK_V = 0x56;
const KEYUP = 0x0002;
const MAX_WORDS = 3;
const MAC_KEY_V = 0x09;
const MAC_KEY_RETURN = 0x24;
const MAC_KEY_COMMAND = 0x37;
const MAC_FLAG_COMMAND = 0x00100000;
const MAC_EVENT_TAP_HID = 0;

let tray;
let overlay;
let controlWindow;
let overlayReady = false;
let spawnQueued = false;
let activeDisplayId = null;
let isQuitting = false;
let settings = { words: [{ label: '承認', text: '' }], activeIndex: 0, sendEnter: false };
let pendingOverlayPayload = null;
let clipboardRestoreTimer = null;
let pendingControlStatus = null;

function getAccessibilityClientName() {
  return process.platform === 'darwin' ? path.parse(process.execPath).name : app.getName();
}

function isAccessibilityTrusted(prompt = false) {
  if (process.platform !== 'darwin') {
    return true;
  }

  try {
    return systemPreferences.isTrustedAccessibilityClient(Boolean(prompt));
  } catch (error) {
    console.warn('yoshiin: accessibility trust check failed:', error.message);
    return false;
  }
}

function getAccessibilityHelpMessage() {
  return `システム設定 > プライバシーとセキュリティ > アクセシビリティ で ${getAccessibilityClientName()} を有効にしてから、再試行してください。`;
}

function quitApp() {
  if (isQuitting) {
    return;
  }

  isQuitting = true;
  globalShortcut.unregisterAll();
  if (tray) {
    tray.destroy();
    tray = null;
  }

  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.destroy();
  }
  if (overlay && !overlay.isDestroyed()) {
    overlay.destroy();
  }

  setTimeout(() => {
    app.exit(0);
  }, 120);

  app.quit();
}

function sanitizeWords(rawWords) {
  if (!Array.isArray(rawWords)) {
    return [];
  }

  return rawWords
    .map(entry => {
      if (typeof entry === 'string') {
        const label = entry.trim();
        return label ? { label, text: '' } : null;
      }
      if (entry && typeof entry === 'object') {
        const label = String(entry.label ?? '').trim();
        const text = String(entry.text ?? '');
        if (!label) {
          return null;
        }
        return { label, text };
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, MAX_WORDS);
}

function sanitizeActiveIndex(rawIndex, words) {
  if (!Array.isArray(words) || !words.length) {
    return 0;
  }

  const parsed = Number(rawIndex);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(0, Math.min(words.length - 1, Math.trunc(parsed)));
}

function normalizeSettings(input) {
  const words = sanitizeWords(input?.words);
  return {
    words,
    activeIndex: sanitizeActiveIndex(input?.activeIndex, words),
    sendEnter: Boolean(input?.sendEnter),
  };
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'));
    return normalizeSettings(saved);
  } catch (_error) {
    return { words: [{ label: '承認', text: '' }], activeIndex: 0, sendEnter: false };
  }
}

function saveSettings(input) {
  settings = Array.isArray(input)
    ? normalizeSettings({ words: input, activeIndex: 0, sendEnter: false })
    : normalizeSettings(input);
  fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
  refreshTrayMenu();
  sendControlState();
  return settings;
}

function getCursorDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function getRelativeCursorPoint(bounds) {
  const point = screen.getCursorScreenPoint();
  return {
    x: point.x - bounds.x,
    y: point.y - bounds.y,
  };
}


function createTrayIcon() {
  const stroke = process.platform === 'win32' ? '%23b21d2a' : '%23000000';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
      <circle cx="11" cy="11" r="7.5" fill="none" stroke="${stroke}" stroke-width="2.2"/>
      <circle cx="11" cy="11" r="4.2" fill="none" stroke="${stroke}" stroke-width="1.8"/>
      <path d="M8.4 8.8h5.2M8.4 11h5.2M8.4 13.2h5.2" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  `.trim();
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  if (process.platform === 'darwin') {
    image.setTemplateImage(true);
  }
  return image.resize({ width: 20, height: 20 });
}

function buildTrayMenu() {
  const wordSummary = settings.words.length ? settings.words.map(w => w.label).join(' / ') : '印鑑ワード未登録';
  const activeLabel = settings.words[settings.activeIndex]?.label || 'なし';
  return Menu.buildFromTemplate([
    { label: 'コントロールパネルを開く', click: showControlWindow },
    { label: 'スタンプモードを発動', enabled: settings.words.length > 0, click: () => activateStampMode(settings) },
    { label: 'スタンプモードを隠す', enabled: Boolean(overlay && overlay.isVisible()), click: hideOverlay },
    { type: 'separator' },
    { label: `選択中: ${activeLabel}`, enabled: false },
    { label: `ワード: ${wordSummary}`, enabled: false },
    { type: 'separator' },
    { label: '終了', click: quitApp },
  ]);
}

function toggleControlWindow() {
  if (!controlWindow || controlWindow.isDestroyed()) {
    createControlWindow();
    return;
  }

  if (controlWindow.isVisible()) {
    controlWindow.hide();
    return;
  }

  showControlWindow();
}

function handleStatusClick() {
  if (overlay && overlay.isVisible()) {
    hideOverlay();
    return;
  }

  toggleControlWindow();
}

function registerOverlayShortcuts() {
  if (!app.isReady()) {
    return;
  }

  globalShortcut.unregister('Escape');
  const ok = globalShortcut.register('Escape', () => {
    if (overlay && overlay.isVisible()) {
      hideOverlay();
    }
  });

  if (!ok) {
    console.warn('yoshiin: failed to register Escape shortcut for stamp mode');
  }
}

function unregisterOverlayShortcuts() {
  if (app.isReady()) {
    globalShortcut.unregister('Escape');
  }
}

function sendControlState(status = null) {
  if (!controlWindow || controlWindow.isDestroyed()) {
    return;
  }

  controlWindow.webContents.send('control-state', {
    platform: process.platform,
    words: settings.words,
    activeIndex: settings.activeIndex,
    sendEnter: settings.sendEnter,
    accessibilityTrusted: isAccessibilityTrusted(false),
    accessibilityClientName: getAccessibilityClientName(),
    status,
  });
}

function positionWindowToTray() {
  if (!controlWindow || controlWindow.isDestroyed() || !tray) {
    return;
  }

  const trayBounds = tray.getBounds();
  const winBounds = controlWindow.getBounds();
  const display = screen.getDisplayMatching(trayBounds);
  const work = display.workArea;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
  let y = Math.round(trayBounds.y + trayBounds.height + 6);

  if (y + winBounds.height > work.y + work.height) {
    y = Math.round(trayBounds.y - winBounds.height - 6);
  }

  x = Math.max(work.x + 6, Math.min(x, work.x + work.width - winBounds.width - 6));
  controlWindow.setPosition(x, y, false);
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 320,
    height: 470,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    autoHideMenuBar: true,
    backgroundColor: '#f2e7d3',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  controlWindow.loadFile(path.join(__dirname, 'control.html'));
  controlWindow.webContents.on('did-finish-load', () => {
    if (!controlWindow || controlWindow.isDestroyed()) {
      return;
    }
    positionWindowToTray();
    controlWindow.show();
    controlWindow.focus();
    sendControlState(pendingControlStatus);
    pendingControlStatus = null;
  });
  controlWindow.on('blur', () => {
    if (!controlWindow || controlWindow.isDestroyed() || isQuitting) {
      return;
    }
    controlWindow.hide();
  });
  controlWindow.on('close', event => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    controlWindow.hide();
  });
  controlWindow.on('closed', () => {
    controlWindow = null;
  });
}

function showControlWindow(status = null) {
  hideOverlay();
  pendingControlStatus = status;
  if (!controlWindow || controlWindow.isDestroyed()) {
    createControlWindow();
    return;
  }

  positionWindowToTray();
  controlWindow.show();
  controlWindow.focus();
  sendControlState(pendingControlStatus);
  pendingControlStatus = null;
}

function createOverlay(display = getCursorDisplay()) {
  const { bounds, id } = display;
  activeDisplayId = id;

  overlay = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  });

  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayReady = false;
  overlay.loadFile(path.join(__dirname, 'overlay.html'));

  overlay.webContents.on('did-finish-load', () => {
    overlayReady = true;
    if (!spawnQueued || !overlay || !overlay.isVisible()) {
      return;
    }
    spawnQueued = false;
    overlay.webContents.send('spawn-stamp', pendingOverlayPayload);
  });

  overlay.on('hide', refreshTrayMenu);
  overlay.on('closed', () => {
    unregisterOverlayShortcuts();
    overlay = null;
    overlayReady = false;
    spawnQueued = false;
    activeDisplayId = null;
    pendingOverlayPayload = null;
    refreshTrayMenu();
  });
}

function destroyOverlay() {
  if (!overlay) {
    return;
  }
  const window = overlay;
  overlay = null;
  window.destroy();
}

function showOverlay() {
  const display = getCursorDisplay();
  if (!overlay || activeDisplayId !== display.id) {
    destroyOverlay();
    createOverlay(display);
  }

  pendingOverlayPayload = {
    point: getRelativeCursorPoint(display.bounds),
    words: settings.words,
    activeIndex: settings.activeIndex,
  };
  overlay.showInactive();
  registerOverlayShortcuts();
  refreshTrayMenu();
  if (overlayReady) {
    overlay.webContents.send('spawn-stamp', pendingOverlayPayload);
  } else {
    spawnQueued = true;
  }
}

function hideOverlay() {
  if (overlay) {
    overlay.hide();
  }
  spawnQueued = false;
  unregisterOverlayShortcuts();
  refreshTrayMenu();
}

function activateStampMode(input = settings) {
  const nextSettings = saveSettings(input);
  if (!nextSettings.words.length) {
    showControlWindow({
      kind: 'error',
      text: 'スタンプモードを発動する前に、印鑑ワードを1つ以上登録してください。',
    });
    return;
  }

  if (process.platform === 'darwin' && !isAccessibilityTrusted(false)) {
    isAccessibilityTrusted(true);
    showControlWindow({
      kind: 'error',
      text: getAccessibilityHelpMessage(),
    });
    return;
  }

  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.hide();
  }

  const successStatus = {
    kind: 'success',
    text: `スタンプモード発動。${nextSettings.words.length}個の印鑑ワードで準備完了！`,
  };

  if (process.platform === 'darwin' && typeof app.hide === 'function') {
    app.hide();
    setTimeout(() => {
      showOverlay();
      sendControlState(successStatus);
    }, 80);
    return;
  }

  showOverlay();
  sendControlState(successStatus);
}

function refreshTrayMenu() {
  if (!tray) {
    return;
  }
}

ipcMain.on('stamp-impact', (_event, phrase) => {
  const text = typeof phrase === 'string' && phrase.trim() ? phrase.trim() : '承認';
  try {
    sendMacro(text);
  } catch (error) {
    console.warn('yoshiin: stamp macro failed:', error.message);
  }
});

ipcMain.on('hide-overlay', () => {
  hideOverlay();
});

ipcMain.on('request-control-state', () => {
  sendControlState();
});

ipcMain.on('request-accessibility-permission', () => {
  const trusted = isAccessibilityTrusted(true);
  sendControlState({
    kind: trusted ? 'success' : 'error',
    text: trusted ? `${getAccessibilityClientName()} が Mac を操作できるようになりました。` : getAccessibilityHelpMessage(),
  });
});

ipcMain.on('save-settings', (_event, words) => {
  const nextSettings = saveSettings(words);
  sendControlState({
    kind: 'success',
    text: nextSettings.words.length
      ? `${nextSettings.words.length}個の印鑑ワードを保存しました。`
      : '保存しました。スタンプモードを発動するには、印鑑ワードを1つ以上登録してください。',
  });
});

ipcMain.on('activate-stamp-mode', (_event, payload) => {
  activateStampMode(payload);
});

function sendMacro(text) {
  if (process.platform === 'win32') {
    sendMacroWindows(text);
    return;
  }
  if (process.platform === 'darwin') {
    sendMacroMac(text);
  }
}

function sendMacroWindows(text) {
  if (!keybd_event) {
    return;
  }

  const previousText = clipboard.readText();

  const tapKey = vk => {
    keybd_event(vk, 0, 0, 0);
    keybd_event(vk, 0, KEYUP, 0);
  };

  clipboard.writeText(text);
  keybd_event(VK_CONTROL, 0, 0, 0);
  keybd_event(VK_V, 0, 0, 0);
  keybd_event(VK_V, 0, KEYUP, 0);
  keybd_event(VK_CONTROL, 0, KEYUP, 0);
  if (settings.sendEnter) {
    setTimeout(() => tapKey(VK_RETURN), 120);
  }
  scheduleClipboardRestore(previousText);
}

function sendMacroMac(text) {
  if (!isAccessibilityTrusted(false)) {
    showControlWindow({
      kind: 'error',
      text: getAccessibilityHelpMessage(),
    });
    return;
  }

  if (!CGEventCreateKeyboardEvent || !CGEventSetFlags || !CGEventPost || !CFRelease) {
    showControlWindow({
      kind: 'error',
      text: 'このビルドでは macOS のキー入力送信が利用できません。',
    });
    return;
  }

  const previousText = clipboard.readText();
  clipboard.writeText(text);
  tapChordMac(MAC_KEY_COMMAND, MAC_FLAG_COMMAND, MAC_KEY_V);
  if (settings.sendEnter) {
    setTimeout(() => tapKeyMac(MAC_KEY_RETURN), 120);
  }
  scheduleClipboardRestore(previousText);
}

function postKeyEventMac(keyCode, keyDown, flags = 0) {
  if (!CGEventCreateKeyboardEvent || !CGEventSetFlags || !CGEventPost || !CFRelease) {
    return;
  }

  const event = CGEventCreateKeyboardEvent(null, keyCode, keyDown);
  if (!event) {
    return;
  }

  if (flags) {
    CGEventSetFlags(event, flags);
  }
  CGEventPost(MAC_EVENT_TAP_HID, event);
  CFRelease(event);
}

function tapKeyMac(keyCode) {
  postKeyEventMac(keyCode, true, 0);
  postKeyEventMac(keyCode, false, 0);
}

function tapChordMac(modifierKeyCode, modifierFlag, keyCode) {
  postKeyEventMac(modifierKeyCode, true, modifierFlag);
  postKeyEventMac(keyCode, true, modifierFlag);
  postKeyEventMac(keyCode, false, modifierFlag);
  postKeyEventMac(modifierKeyCode, false, 0);
}

function scheduleClipboardRestore(text) {
  if (clipboardRestoreTimer) {
    clearTimeout(clipboardRestoreTimer);
  }

  clipboardRestoreTimer = setTimeout(() => {
    clipboard.writeText(text);
  }, 260);
}

app.whenReady().then(() => {
  settings = loadSettings();

  tray = new Tray(createTrayIcon());
  tray.setToolTip('yoshiin');
  if (process.platform === 'darwin' && typeof tray.setHighlightMode === 'function') {
    tray.setHighlightMode('selection');
  }
  if (process.platform === 'darwin' && typeof tray.setTitle === 'function') {
    tray.setTitle('印');
  }
  if (process.platform === 'darwin' && typeof tray.setIgnoreDoubleClickEvents === 'function') {
    tray.setIgnoreDoubleClickEvents(true);
  }
  refreshTrayMenu();
  tray.on('click', handleStatusClick);
  tray.on('right-click', () => {
    tray.popUpContextMenu(buildTrayMenu());
  });
  showControlWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on('window-all-closed', event => {
  if (!isQuitting) {
    event.preventDefault();
  }
});

app.on('activate', () => {
  if (!isQuitting) {
    showControlWindow();
  }
});
