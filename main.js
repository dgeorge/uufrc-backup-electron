const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const dns = require('node:dns');
const crypto = require('node:crypto');
const { google } = require('googleapis');

// In development, .env lives beside main.js in the project root.
// In a packaged app there is no project root on disk, so we look in the
// OS user-data directory — the same folder where tokens.json is stored:
//   macOS:   ~/Library/Application Support/uufrcBackup/.env
//   Windows: %APPDATA%\uufrcBackup\.env
// In a packaged app, electron-builder copies .env into the Resources folder
// alongside the app bundle. In development it lives in the project root.
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '.env');
require('dotenv').config({ path: envPath });

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SCOPES = ['https://www.googleapis.com/auth/drive'];

// dialog.showErrorBox is safe to call before app.whenReady(), so if the
// credentials file is missing the user gets a clear message with the exact
// path where they need to place it, rather than a silent crash.
if (!CLIENT_ID || !CLIENT_SECRET) {
  dialog.showErrorBox(
    'Missing credentials',
    'Google OAuth credentials not found.\n\n' +
    'Create a file named ".env" at:\n\n' +
    `  ${envPath}\n\n` +
    'with the following contents:\n\n' +
    '  GOOGLE_CLIENT_ID=<your client id>\n' +
    '  GOOGLE_CLIENT_SECRET=<your client secret>\n\n' +
    'See .env.example in the source repository for details.'
  );
  app.exit(1);
}

let mainWindow = null;

// ── File logger ────────────────────────────────────────────────────────────────
//
// Writes timestamped entries to:
//   macOS:   ~/Library/Logs/uufrcBackup/main.log
//   Windows: %APPDATA%\uufrcBackup\logs\main.log
//
// In development (npm start) output also goes to the console so the terminal
// stays useful. In a packaged app the file is the only durable record.

let _logPath = null;

function _writelog(level, args) {
  const message = args
    .map(a => a instanceof Error ? (a.stack || a.message) : String(a))
    .join(' ');
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  try {
    if (!_logPath) {
      const dir = app.getPath('logs');
      fs.mkdirSync(dir, { recursive: true });
      _logPath = path.join(dir, 'main.log');
    }
    fs.appendFileSync(_logPath, line);
  } catch { /* never let a logging failure crash the app */ }
  if (!app.isPackaged) {
    (level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log)(message);
  }
}

const log = {
  info:  (...args) => _writelog('INFO',  args),
  warn:  (...args) => _writelog('WARN',  args),
  error: (...args) => _writelog('ERROR', args),
};


// ── Token persistence ──────────────────────────────────────────────────────────

// When the user finishes authenticating, we get an auth token and a refresh token.
// The code in this section stores the refresh token on the local disk in a tokens.json
// file. When the app runs again later, it reads the tokens.json file instead of 
// prompting the user to authenticate again.
//
// The location of that tokens.json file is chosen by the Electron framework; on MacOS,
// it is stored in the "~/Library/Application Support" directory.

function getTokenPath() {
  return path.join(app.getPath('userData'), 'tokens.json');
}

function saveTokens(tokens) {
  fs.writeFileSync(getTokenPath(), JSON.stringify(tokens, null, 2));
}

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(getTokenPath(), 'utf8'));
  } catch {
    return null;
  }
}


// ── OAuth via local redirect server ───────────────────────────────────────────

function createOAuth2Client(redirectUri) {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, redirectUri);
}

/**
 * Starts a temporary HTTP server on a random port, opens the browser to the
 * Google consent screen, waits for the redirect, then resolves with an
 * authenticated OAuth2 client.
 */
function runOAuthFlow() {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');

	// The call to server.openExternal(), which is later in this function, will open a 
	// system browser and load the Goole OAuth UI in that browser. If the user successfully
	// authenticates and grants access to this application, then Google's OAuth code will 
	// invoke a redirect URI that we specify. That URI is localhost with a custom port. 
	// The handler that receives that URI is included just below this comment, but it isn't
	// executed until the OAuth flow is done.
    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url, 'http://localhost');

      if (reqUrl.pathname !== '/oauth-redirect') {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = reqUrl.searchParams.get('code');
      const returnedState = reqUrl.searchParams.get('state');
      const error = reqUrl.searchParams.get('error');
      const { port } = server.address();

      // Always close the server after one callback
      server.close();

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(htmlPage('Authentication failed', `<p>Google returned an error: <strong>${escapeHtml(error)}</strong></p><p>You can close this tab.</p>`));
        return reject(new Error(`OAuth error: ${error}`));
      }

      if (returnedState !== state) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(htmlPage('Authentication failed', '<p>Invalid state parameter. Possible CSRF attack.</p><p>You can close this tab.</p>'));
        return reject(new Error('OAuth state mismatch'));
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(htmlPage('Signed in', '<p>Authentication successful! You can close this tab and return to the app.</p>'));

      try {
        const redirectUri = `http://localhost:${port}/oauth-redirect`;
        const oauth2Client = createOAuth2Client(redirectUri);
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        if (tokens.refresh_token) {
          saveTokens({ refresh_token: tokens.refresh_token });
        }
        resolve(oauth2Client);
      } catch (err) {
        reject(err);
      }
    });

    // This server.listen call creates a temporary web server which will listen for the 
    // call to the redirect URI mentioned above. The first parameter to server.listen is the 
    // port number. By passing zero, we're instructing the operating system to dynamically
    // assign an available port. The callback function is invoked after the server begins
    // listening. When the callback function is invoked, we learn what port number is being
    // used, and the call to server.openExternal() causes the system browser to be opened for
    // the OAuth flow to begin.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const redirectUri = `http://localhost:${port}/oauth-redirect`;
      const oauth2Client = createOAuth2Client(redirectUri);

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        state,
        prompt: 'consent', // ensures refresh_token is always returned
      });

      shell.openExternal(authUrl);
    });

    server.on('error', reject);
  });
}


// ── Retry with exponential backoff ──────────────────────────────────────────────

// Google Drive returns transient failures under load: rate limiting (HTTP 429,
// or 403 with reason rateLimitExceeded/userRateLimitExceeded), server errors
// (5xx), and dropped network connections. These succeed if retried after a
// short pause. Permanent errors (401 unauthorized, 404 not found, real 403
// permission denials, etc.) are NOT retried — retrying them just wastes time.

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(err) {
  // Network-level failures surface as string codes with no HTTP status.
  const netCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'];
  if (typeof err?.code === 'string' && netCodes.includes(err.code)) return true;

  const status = typeof err?.code === 'number' ? err.code : err?.response?.status;
  if (status === 429) return true;                       // Too Many Requests
  if (status >= 500 && status < 600) return true;        // Server-side errors
  if (status === 403) {
    // A 403 is only transient when it is a rate-limit; a permission denial is permanent.
    const reasons = (err?.errors || err?.response?.data?.error?.errors || []).map(e => e.reason);
    return reasons.some(r => r === 'rateLimitExceeded' || r === 'userRateLimitExceeded');
  }
  return false;
}

// Runs an async Drive operation, retrying transient failures with exponential
// backoff plus random jitter. `label` is used only for log/status messages.
async function withRetry(operation, label = 'Drive operation') {
  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (err) {
      attempt++;
      if (attempt > MAX_RETRIES || !isRetryableError(err)) {
        throw err;
      }
      // Exponential backoff: BASE * 2^(attempt-1), plus up to 1s of jitter so
      // many concurrent retries don't resynchronize into a thundering herd.
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 1000);
      log.warn(`${label} failed (${err?.code ?? 'error'}); retry ${attempt}/${MAX_RETRIES} in ${delay}ms: ${err?.message}`);
      await sleep(delay);
    }
  }
}


// ── Append a log of copied files to a backup.csv file ──────────────────────────

function csvEscape(value) {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

async function appendToBackupCsv(drive, records) {
  const columns = ['name', 'folder', 'owner', 'size', 'createdTime', 'modifiedTime', 'copiedTime'];
  const newRows = records.map(r => columns.map(c => csvEscape(r[c])).join(',')).join('\n');

  const searchRes = await withRetry(() => drive.files.list({
    q: "name = 'backup.csv' and 'root' in parents and trashed = false",
    fields: 'files(id)',
    pageSize: 1,
  }), 'find backup.csv');
  const existingFile = searchRes.data.files[0];

  if (existingFile) {
    // The download (request + draining the stream) is retried as one unit: if
    // the connection drops mid-stream we must re-issue the request and start
    // reading from scratch, not resume a half-consumed stream.
    const existingContent = await withRetry(async () => {
      const downloadRes = await drive.files.get(
        { fileId: existingFile.id, alt: 'media' },
        { responseType: 'stream' }
      );
      return await new Promise((resolve, reject) => {
        const chunks = [];
        downloadRes.data.on('data', d => chunks.push(d));
        downloadRes.data.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        downloadRes.data.on('error', reject);
      });
    }, 'download backup.csv');
    await withRetry(() => drive.files.update({
      fileId: existingFile.id,
      media: { mimeType: 'text/plain', body: existingContent + '\n' + newRows },
    }), 'update backup.csv');
  } else {
    const headerRow = columns.join(',');
    await withRetry(() => drive.files.create({
      requestBody: { name: 'backup.csv' },
      media: { mimeType: 'text/plain', body: headerRow + '\n' + newRows },
      fields: 'id',
    }), 'create backup.csv');
  }
}


// ── Google Drive ───────────────────────────────────────────────────────────────

async function fetchBackedUpMap(drive, backupFolderId) {
  const map = new Map();
  let pageToken = undefined;
  do {
    const res = await withRetry(() => drive.files.list({
      q: `'${backupFolderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, properties)',
      pageSize: 100,
      pageToken,
    }), 'list backup folder contents');
    for (const f of res.data.files || []) {
      if (f.properties?.uufrc_backup_original_id) {
        map.set(f.properties.uufrc_backup_original_id, {
          id: f.id,
          version: f.properties.uufrc_backup_original_version,
        });
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return map;
}

// If a folder is shared with this user, then this function traverses the contents of that folder
// and copies all new (or changed) files contained in that folder. This function is also invoked
// recursively to copy files contained in nested subfolders.
//
// drive: The object used to access Google Drive APIs
// sourceFolderId: the id of the folder that we are copying
// folderPath: the full path of the folder being copied, relative to the top-level shared folder
//   (e.g. "Finance" at the top level, "Finance/2024" for a nested subfolder). Used in CSV records
//   so every file carries its complete path.
// backupParentId: the id of the directory to which this folder should be copied. In other words,
//   the copied folder will be a child of the folder specified with this id.
// backedUpInParent: a record of all the files and folders that already exist folder referenced
//   by backupParentId. If this folder already exists in that diretory, then don't create it again
// records: an array in which we record the list of files that have been copied; it will be
//   appended to a "backup.csv" file
async function syncFolder(drive, sourceFolderId, folderPath, backupParentId, backedUpInParent, records) {
  let backupFolderId = backedUpInParent.get(sourceFolderId)?.id;

  // The backup folder only needs the immediate name (the last path component); the
  // full hierarchy is already expressed by its position within the backup tree.
  const folderName = folderPath.split('/').pop();

  if (!backupFolderId) {
    const created = await withRetry(() => drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [backupParentId],
        properties: { uufrc_backup_original_id: sourceFolderId },
      },
      fields: 'id',
    }), `create backup folder "${folderName}"`);
    backupFolderId = created.data.id;
  }

  // Get a list of all the files and folders that already exist in the destination directory
  const backedUpInFolder = await fetchBackedUpMap(drive, backupFolderId);

  // Get a list of all the files and folders contained in sourceFolderId
  const subfolders = [];
  const filesToCopy = [];
  let pageToken = undefined;
  do {
    const res = await withRetry(() => drive.files.list({
      q: `'${sourceFolderId}' in parents and mimeType != 'application/vnd.google-apps.shortcut' and not mimeType contains 'image/' and not mimeType contains 'video/' and not mimeType contains 'audio/' and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, version, owners, size, createdTime, modifiedTime)',
      pageSize: 100,
      pageToken,
    }), 'list shared folder contents');
    for (const f of res.data.files || []) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        subfolders.push(f);
      } else {
        filesToCopy.push({ ...f, folderPath });
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  // Copy the files contained in this folder
  await copyFiles(drive, filesToCopy, backupFolderId, backedUpInFolder, records);

  // Recursively copy child subfolders
  for (const subfolder of subfolders) {
    await syncFolder(drive, subfolder.id, `${folderPath}/${subfolder.name}`, backupFolderId, backedUpInFolder, records);
  }
}

// Copy all the files (as opposed to folders) that are in the root "sharedWithMe" folder or in a 
// shared folder.
//
// drive: The object used to access Google Drive APIs
// files: An array of the files to be copied
// backupParentId: the id of the directory to which the files should be copied. In other words,
//   the copied files will be children of the folder specified with this id.
// backedUpIds: the ids of the files already contained in the destination directory. We don't
//   want to copy a file if that file already exists and it hasn't changed
// records: an array in which we record the list of files that have been copied; it will be 
//   appended to a "backup.csv" file
async function copyFiles(drive, files, backupParentId, backedUpIds, records) {
  for (const file of files) {
    const existing = backedUpIds.get(file.id);
    if (existing && existing.version === file.version) continue;

    // Copy the new version BEFORE deleting the old one. files.delete is a
    // permanent delete (no trash), so if we deleted first and the copy then
    // failed (network, rate limit, quota), the only backup copy would be lost.
    // By copying first, a failed copy leaves the previous backup intact.
    await withRetry(() => drive.files.copy({
      fileId: file.id,
      requestBody: {
        parents: [backupParentId],
        properties: {
          uufrc_backup_original_id: file.id,
          uufrc_backup_original_version: file.version,
        },
      },
      fields: 'id',
    }), `copy "${file.name}"`);
    if (existing) {
      await withRetry(() => drive.files.delete({ fileId: existing.id }), `delete old copy of "${file.name}"`);
    }
    const folder = file.folderPath || '';
    log.info(`Copied "${file.name}"${folder ? ` from folder "${folder}"` : ''} (size: ${file.size || 'unknown'}, modified: ${file.modifiedTime || 'unknown'})`);
    records.push({
      name: file.name,
      folder,
      owner: file.owners?.length === 1 ? file.owners[0].displayName : '',
      size: file.size || '',
      createdTime: file.createdTime || '',
      modifiedTime: file.modifiedTime || '',
      copiedTime: new Date().toISOString(),
    });
  }
}

// This is the root function that performs the backup. It traverses all the files and folders that
// have been shared with this user, creating a copy of those files and folders in the "backup" directory
// on this user's Google Drive.
//
// To save time, we only copy files that have changed since the last time this app was executed.
// To save space, we do not copy videos, images, or audios.
async function updateBackup(auth) {
  const drive = google.drive({ version: 'v3', auth });
  const allFilesAndFolders = [];
  let pageToken = undefined;

  // Get a reference to the folder named "backup", which is contained in the root directory of this
  // user's Google Drive. Create it if it doesn't exist.
  const backupRes = await withRetry(() => drive.files.list({
    q: "name = 'backup' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false",
    fields: 'files(id)',
    pageSize: 1,
  }), "find 'backup' folder");
  let backupFolderId = backupRes.data.files[0]?.id;
  if (!backupFolderId) {
    const created = await withRetry(() => drive.files.create({
      requestBody: {
        name: 'backup',
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id',
    }), "create 'backup' folder");
    backupFolderId = created.data.id;
  }

  // Get a list of all the files and folders that have been shared with this user (excluding images,
  // videos, and audios)
  do {
    const response = await withRetry(() => drive.files.list({
      pageSize: 100,
      fields: 'nextPageToken, files(id, name, mimeType, version, owners, size, createdTime, modifiedTime)',
      q: "sharedWithMe = true and mimeType != 'application/vnd.google-apps.shortcut' and not mimeType contains 'image/' and not mimeType contains 'video/' and not mimeType contains 'audio/' and trashed = false",
      orderBy: 'name',
      pageToken,
    }), 'list shared files');
    allFilesAndFolders.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  // Get a list of all the files and folders that have already been copied, so that we don't
  // needlessly copy them again.
  const backedUpInRoot = await fetchBackedUpMap(drive, backupFolderId);

  // For all files that have been shared with this user, make a copy of the file if it meets
  // the criteria described at the top of this function.
  const sharedFiles = allFilesAndFolders.filter(f => f.mimeType !== 'application/vnd.google-apps.folder');
  const records = [];
  await copyFiles(drive, sharedFiles, backupFolderId, backedUpInRoot, records);

  // For each folder that have been shared with this user, create a subfolder in the "backup" folder
  // that has the same name, and copy files from the shared folder to the subfolder in backup.
  // Repeat this process recursively for the entire folder hierarchy.
  const sharedFolders = allFilesAndFolders.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
  for (const folder of sharedFolders) {
    await syncFolder(drive, folder.id, folder.name, backupFolderId, backedUpInRoot, records);
  }

  if (records.length > 0) {
    await appendToBackupCsv(drive, records);
  }
  log.info(`Backup complete. ${records.length} file(s) copied.`);
}

// Resolves true if www.googleapis.com is reachable, false otherwise.
// A 5-second timeout guards against hanging on a captive portal or a
// connection that is technically "up" but not routing to the internet.
function checkInternetConnection() {
  return Promise.race([
    dns.promises.lookup('www.googleapis.com').then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 5000)),
  ]).catch(() => false);
}


// After all the Electron boilerplate executes, this is the main function in the app.
// This function ensures that the user is authenticated and then initiates the
// work to perform the backup.
async function authenticateAndBackup() {
  if (!await checkInternetConnection()) {
    log.info('No internet connection detected — exiting without running backup.');
    app.quit();
    return;
  }

  const stored = loadTokens();

  // If the user previously authenticated successfully, a refresh token was saved
  // to disk. Use it to run the backup entirely silently — no window needed.
  if (stored && stored.refresh_token) {
    const oauth2Client = createOAuth2Client('');
    oauth2Client.setCredentials({ refresh_token: stored.refresh_token });
    try {
      await updateBackup(oauth2Client);
      app.quit();
      return;
    } catch (err) {
      log.error('Stored token failed, re-authenticating:', err.message);
      // Fall through to the OAuth flow below.
    }
  }

  // Authentication is required. Show a window so the user knows to look at the
  // browser, then open the Google sign-in page.
  showWindow('show-auth');
  let oauth2Client = null;
  try {
    oauth2Client = await runOAuthFlow();
  } catch (err) {
    log.error('OAuth flow failed:', err);
    showWindow('show-error', err.message);
    return;
  }

  // Auth succeeded. Hide the window so backup runs silently.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }

  try {
    await updateBackup(oauth2Client);
    app.quit();
  } catch (err) {
    log.error('GDrive access failed:', err);
    showWindow('show-error', err.message);
  }
}

// ── Electron boilerplate ───────────────────────────────────────────────────────

// Creates a window (if one isn't already open) and sends it an IPC message
// that tells index.html which view to display. If the window exists but is
// hidden (e.g. after a successful OAuth flow), it is made visible again.
// Channel is either 'show-auth' or 'show-error'.
function showWindow(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.webContents.send(channel, data);
    return;
  }
  mainWindow = new BrowserWindow({
    width: 480,
    height: 260,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.loadFile('index.html');
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send(channel, data);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}


// Start the backup immediately on launch — no window unless auth or an error
// requires one.
app.whenReady().then(() => {
  authenticateAndBackup();
});

// Always quit when the last window closes. This app has no persistent dock
// presence — once the auth or error window is dismissed the process should end.
app.on('window-all-closed', () => {
  app.quit();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlPage(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
  <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5}
  .card{background:white;padding:40px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.15);text-align:center;max-width:400px}
  h1{color:#1a73e8;margin-bottom:16px}p{color:#555}</style>
  </head><body><div class="card"><h1>${escapeHtml(title)}</h1>${body}</div></body></html>`;
}
