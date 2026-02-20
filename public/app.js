const ws = new WebSocket(`ws://${window.location.host}`);
const torrentList = document.getElementById('torrent-list');
const emptyState = torrentList.querySelector('.empty-state');
const toastContainer = document.getElementById('toast-container');

// Settings state
let currentSettings = {};

// Rating state
let myPublicKey = null;
let seederKeys = new Map(); // torrentKey -> seederKey

// Toast notification system
function showToast(message, type = 'info', duration = 5000) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = {
        success: 'fa-circle-check',
        error: 'fa-circle-exclamation',
        warning: 'fa-triangle-exclamation',
        info: 'fa-circle-info'
    };

    toast.innerHTML = `
        <i class="fa-solid ${icons[type]} toast-icon"></i>
        <span class="toast-message">${message}</span>
        <button class="toast-close" onclick="this.parentElement.remove()">
            <i class="fa-solid fa-xmark"></i>
        </button>
    `;

    toastContainer.appendChild(toast);

    // Auto-remove after duration
    if (duration > 0) {
        setTimeout(() => {
            toast.classList.add('hiding');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }
}

ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'update') {
        renderTorrents(message.data);
    }
};

async function renderTorrents(torrents) {
    if (torrents.length === 0) {
        emptyState.style.display = 'block';
        // Remove existing cards
        const cards = torrentList.querySelectorAll('.torrent-card');
        cards.forEach(c => c.remove());
        return;
    }

    emptyState.style.display = 'none';

    for (const torrent of torrents) {
        let card = document.getElementById(`torrent-${torrent.key}`);

        if (!card) {
            card = document.createElement('div');
            card.id = `torrent-${torrent.key}`;
            card.className = 'torrent-card';
            torrentList.appendChild(card);
        }

        // Загружаем ключ сида для скачиваний
        if ((torrent.type.startsWith('downloading') || torrent.type === 'metadata-fetching' || torrent.type === 'metadata-ready') && !seederKeys.has(torrent.key)) {
            await loadSeederKey(torrent.key);
        }

        let typeLabel, typeIcon;
        switch (torrent.type) {
            case 'seeding':
                typeLabel = 'Seeding';
                typeIcon = 'fa-arrow-up';
                break;
            case 'seeding-dir':
                typeLabel = 'Seeding Dir';
                typeIcon = 'fa-folder';
                break;
            case 'downloading':
                typeLabel = 'Downloading';
                typeIcon = 'fa-arrow-down';
                break;
            case 'downloading-dir':
                typeLabel = 'Downloading Dir';
                typeIcon = 'fa-folder-arrow-down';
                break;
            case 'metadata-fetching':
                typeLabel = 'Fetching Metadata';
                typeIcon = 'fa-spinner fa-spin';
                break;
            case 'metadata-ready':
                typeLabel = 'Metadata Ready';
                typeIcon = 'fa-list-check';
                break;
            case 'syncing':
                typeLabel = 'Syncing Updates...';
                typeIcon = 'fa-sync fa-spin';
                break;
            default:
                typeLabel = torrent.type;
                typeIcon = 'fa-circle-question';
        }

        const fileInfo = torrent.fileCount
            ? `${torrent.fileCount} file${torrent.fileCount > 1 ? 's' : ''}`
            : formatBytes(torrent.size);

        // Проверяем, свой ли это сидер
        const isOwn = isOwnSeeder(torrent.key);
        const seederKey = seederKeys.get(torrent.key);
        const rating = seederKey ? await fetchRating(seederKey) : null;
        const trustScore = rating ? rating.trustScore : null;
        const avgRating = rating ? rating.averageSpeed : null;

        card.innerHTML = `
      <div class="torrent-info">
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <div class="torrent-name">${torrent.name}</div>
          <button class="btn-remove" onclick="handleRemove('${torrent.key}')" title="Remove torrent">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
        <div class="torrent-meta">
          <span><i class="fa-solid ${typeIcon}"></i> ${typeLabel}</span>
          <span>${fileInfo}</span>
        </div>
        ${seederKey && !isOwn ? `
          <div class="torrent-rating">
            ${renderMiniStars(avgRating)}
            <span class="trust-badge trust-${getTrustLevel(trustScore)}">${trustScore}%</span>
          </div>
        ` : ''}
        ${seederKey && isOwn ? `
          <div class="torrent-rating" style="color: var(--accent-blue);">
            <i class="fa-solid fa-circle-check"></i> Your seed
          </div>
        ` : ''}
      </div>
      <div class="progress-container">
        <div class="progress-bar" style="width: ${torrent.progress}%"></div>
      </div>
      <div class="torrent-stats">
        <div class="stat-item">
          <i class="fa-solid fa-users"></i>
          <span class="stat-value">${torrent.peers}</span> peers
        </div>
        <div class="stat-item">
          <span class="stat-value">${torrent.progress}%</span>
        </div>
      </div>
      <div class="key-display-small" onclick="copyKey('${torrent.key}')" title="Click to copy key">
        ${torrent.key.slice(0, 8)}...${torrent.key.slice(-8)}
      </div>
      ${seederKey && !isOwn ? `
        <button class="btn-rate-peer" onclick="openRateModal('${seederKey}')" title="Rate this peer">
          <i class="fa-solid fa-star"></i> Rate Peer
        </button>
      ` : ''}

      ${torrent.hasLocalChanges ? `
        <div class="update-badge badge-local">
          <i class="fa-solid fa-cloud-arrow-up"></i> Local changes detected
          <button class="btn-sync" onclick="syncSeed('${torrent.key}')">Publish</button>
        </div>
      ` : ''}

      ${torrent.hasRemoteUpdate ? `
        <div class="update-badge badge-remote">
          <i class="fa-solid fa-cloud-arrow-down"></i> Update available (v${torrent.remoteVersion})
          <button class="btn-sync" onclick="showSyncDiff('${torrent.key}')">Review</button>
        </div>
        <div id="diff-${torrent.key}" class="sync-diff-container" style="display: none;"></div>
      ` : ''}
      
      ${torrent.type === 'metadata-ready' ? `
        <div class="file-selection-list">
          <div class="tree-root">
            ${renderTreeHtml(buildFileTree(torrent.files), torrent.key, torrent.name)}
          </div>
        </div>
        <div class="metadata-actions">
           <button class="btn-cancel-download" onclick="handleRemove('${torrent.key}')">
             <i class="fa-solid fa-xmark"></i> Cancel
           </button>
           <button class="btn-start-download" onclick="confirmDownload('${torrent.key}')">
             <i class="fa-solid fa-download"></i> Start
           </button>
        </div>
      ` : ''}

      ${torrent.error ? `<div class="error" style="color: #ff4d4d; font-size: 0.8rem; margin-top: 10px;">${torrent.error}</div>` : ''}
    `;
    }

    // Clean up removed torrents
    const currentKeys = torrents.map(t => `torrent-${t.key}`);
    const cards = torrentList.querySelectorAll('.torrent-card');
    cards.forEach(card => {
        if (!currentKeys.includes(card.id)) card.remove();
    });
}

// Tree view helper: builds a nested object from flat paths
function buildFileTree(files) {
    const root = {};
    files.forEach(file => {
        // Remove leading slash if exists
        const pathParts = (file.path.startsWith('/') ? file.path.slice(1) : file.path).split('/');
        let current = root;
        pathParts.forEach((part, index) => {
            if (!current[part]) {
                current[part] = index === pathParts.length - 1 ? { _file: file } : {};
            }
            current = current[part];
        });
    });
    return root;
}

// Recursively renders the file tree as HTML
function renderTreeHtml(node, torrentKey, torrentName, currentPath = '') {
    let html = '';
    const entries = Object.entries(node);

    // Sort directories first
    entries.sort(([a, valA], [b, valB]) => {
        const isDirA = !valA._file;
        const isDirB = !valB._file;
        if (isDirA && !isDirB) return -1;
        if (!isDirA && isDirB) return 1;
        return a.localeCompare(b);
    });

    entries.forEach(([name, value]) => {
        const fullPath = currentPath + '/' + name;
        if (value._file) {
            // It's a file
            const displayName = name === 'file' && currentPath === '' ? (torrentName || 'file') : name;
            html += `
                <div class="tree-node file-item">
                    <input type="checkbox" id="file-${torrentKey}-${value._file.path}" data-path="${value._file.path}" checked>
                    <label for="file-${torrentKey}-${value._file.path}" class="file-name">${displayName}</label>
                    <span class="file-size">${formatBytes(value._file.size)}</span>
                </div>
            `;
        } else {
            // It's a directory
            const dirId = `dir-${torrentKey}-${fullPath.replace(/\//g, '-')}`;
            html += `
                <div class="tree-node">
                    <div class="folder-item" onclick="toggleFolderSelection('${torrentKey}', '${fullPath}', this)">
                        <div class="folder-toggle" onclick="event.stopPropagation(); toggleFolderCollapse(this)">−</div>
                        <i class="fa-solid fa-folder-open"></i>
                        <input type="checkbox" id="${dirId}" checked onclick="event.stopPropagation(); toggleFolderSelection('${torrentKey}', '${fullPath}', this.parentElement)">
                        <span class="folder-name">${name}</span>
                    </div>
                    <div class="folder-content" data-path="${fullPath}">
                        ${renderTreeHtml(value, torrentKey, torrentName, fullPath)}
                    </div>
                </div>
            `;
        }
    });
    return html;
}

function toggleFolderSelection(torrentKey, folderPath, folderEl) {
    const checkbox = folderEl.querySelector('input[type="checkbox"]');
    // If called from onclick of the div, toggle checkbox state first
    if (event.target !== checkbox && !event.target.classList.contains('folder-toggle')) {
        checkbox.checked = !checkbox.checked;
    }

    const isChecked = checkbox.checked;
    const content = folderEl.nextElementSibling;

    // Find all checkboxes within this folder and set their state
    const subCheckboxes = content.querySelectorAll('input[type="checkbox"]');
    subCheckboxes.forEach(cb => cb.checked = isChecked);
}

function toggleFolderCollapse(toggleEl) {
    const folderItem = toggleEl.parentElement;
    const content = folderItem.nextElementSibling;
    const isCollapsed = content.classList.toggle('collapsed');
    toggleEl.textContent = isCollapsed ? '+' : '−';

    // Update folder icon
    const icon = folderItem.querySelector('i');
    if (isCollapsed) {
        icon.classList.remove('fa-folder-open');
        icon.classList.add('fa-folder');
    } else {
        icon.classList.remove('fa-folder');
        icon.classList.add('fa-folder-open');
    }
}

function copyKey(key) {
    navigator.clipboard.writeText(key);
    showToast('Key copied to clipboard!', 'success', 3000);
}

async function handleRemove(key) {
    if (!confirm('Are you sure you want to stop and remove this torrent?')) return;

    try {
        const response = await fetch('/api/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key })
        });
        const result = await response.json();
        if (!result.success) showToast(result.error, 'error');
    } catch (err) {
        showToast('Failed to remove torrent', 'error');
    }
}

function resetSeedModal() {
    document.getElementById('seed-path').value = '';
    document.getElementById('seed-name').value = '';
    document.getElementById('seed-form-content').style.display = 'block';
    document.getElementById('seed-result').style.display = 'none';
    document.getElementById('seed-loading').style.display = 'none';
    toggleSeedType(); // Reset label and placeholder
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/* Modal Logic */
function openModal(type) {
    document.getElementById(`modal-${type}`).style.display = 'flex';
    if (type === 'seed') resetSeedModal();
    if (type === 'download') {
        const savePathInput = document.getElementById('save-path');
        if (savePathInput && !savePathInput.value) {
            savePathInput.value = currentSettings.downloadPath || './downloads';
        }
    }
}

function closeModal(type) {
    document.getElementById(`modal-${type}`).style.display = 'none';
}

async function handleSeed() {
    const path = document.getElementById('seed-path').value;
    const name = document.getElementById('seed-name').value.trim() || null;

    if (!path) return showToast('Please select a file or directory', 'warning');

    // Show loading state
    const formContent = document.getElementById('seed-form-content');
    const loadingState = document.getElementById('seed-loading');
    formContent.style.display = 'none';
    loadingState.style.display = 'block';

    try {
        const response = await fetch('/api/seed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, name })
        });
        const result = await response.json();

        loadingState.style.display = 'none';

        if (result.success) {
            document.getElementById('seed-result').style.display = 'block';
            const keyDiv = document.getElementById('generated-key');
            keyDiv.textContent = result.key;
            keyDiv.onclick = () => copyKey(result.key);
            showToast('Torrent created successfully!', 'success', 3000);
        } else {
            formContent.style.display = 'block';
            showToast(result.error, 'error');
        }
    } catch (err) {
        loadingState.style.display = 'none';
        formContent.style.display = 'block';
        showToast('Failed to connect to server', 'error');
    }
}

async function handleDownload() {
    const key = document.getElementById('download-key').value;
    const savePath = document.getElementById('save-path').value || currentSettings.downloadPath || './downloads';

    if (!key) return showToast('Please enter a key', 'warning');

    try {
        const response = await fetch('/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, savePath })
        });
        const result = await response.json();

        if (result.success) {
            closeModal('download');
            showToast('Download started!', 'success', 3000);
        } else {
            showToast(result.error, 'error');
        }
    } catch (err) {
        showToast('Failed to connect to server', 'error');
    }
}

async function confirmDownload(key) {
    const card = document.getElementById(`torrent-${key}`);
    const checkboxes = card.querySelectorAll('.file-selection-list input[type="checkbox"]:checked');
    const selectedFiles = Array.from(checkboxes).map(cb => cb.dataset.path);

    if (selectedFiles.length === 0) return showToast('Please select at least one file to download', 'warning');

    try {
        const response = await fetch('/api/confirm-download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, selectedFiles })
        });
        const result = await response.json();
        if (!result.success) showToast(result.error, 'error');
    } catch (err) {
        showToast('Failed to start download', 'error');
    }
}

async function syncSeed(key) {
    try {
        const response = await fetch('/api/sync-seed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key })
        });
        const result = await response.json();
        if (!result.success) showToast(result.error, 'error');
    } catch (err) {
        showToast('Failed to sync seed', 'error');
    }
}

async function showSyncDiff(key) {
    const diffContainer = document.getElementById(`diff-${key}`);
    if (diffContainer.style.display === 'block') {
        diffContainer.style.display = 'none';
        return;
    }

    try {
        diffContainer.innerHTML = '<div class="diff-loading"><i class="fa-solid fa-spinner fa-spin"></i> Calculating changes...</div>';
        diffContainer.style.display = 'block';

        const response = await fetch(`/api/sync-diff?key=${key}`);
        const result = await response.json();

        if (result.success) {
            if (result.diff.length === 0) {
                diffContainer.innerHTML = '<div class="diff-empty">No file changes detected (metadata update only).</div>' +
                    `<button class="btn-sync-confirm" onclick="syncDownload('${key}')">Apply Metadata Update</button>`;
            } else {
                let html = '<div class="diff-title">Files to update:</div><ul class="diff-list">';
                result.diff.forEach(file => {
                    html += `<li><i class="fa-solid fa-file-pen"></i> ${file.path} <span class="diff-size">(${formatBytes(file.size)})</span></li>`;
                });
                html += '</ul>';
                html += `<button class="btn-sync-confirm" onclick="syncDownload('${key}')">Download & Apply Update</button>`;
                diffContainer.innerHTML = html;
            }
        } else {
            diffContainer.innerHTML = `<div class="diff-error">Error: ${result.error}</div>`;
        }
    } catch (err) {
        diffContainer.innerHTML = '<div class="diff-error">Failed to fetch diff</div>';
    }
}

async function syncDownload(key) {
    try {
        const response = await fetch('/api/sync-download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key })
        });
        const result = await response.json();
        if (!result.success) showToast(result.error, 'error');
    } catch (err) {
        showToast('Failed to sync download', 'error');
    }
}

async function browseFile() {
    const filePath = await window.electronAPI.selectFile();
    if (filePath) {
        document.getElementById('seed-path').value = filePath;
    }
}

async function browseDirectory() {
    const dirPath = await window.electronAPI.selectDirectory();
    if (dirPath) {
        document.getElementById('save-path').value = dirPath;
    }
}

async function browseSeedPath() {
    const seedType = document.querySelector('input[name="seed-type"]:checked').value;
    const path = await window.electronAPI.selectPath({ allowDirectory: seedType === 'directory' });
    if (path) {
        document.getElementById('seed-path').value = path;
    }
}

function toggleSeedType() {
    const seedType = document.querySelector('input[name="seed-type"]:checked').value;
    const placeholder = seedType === 'directory' ? 'Select a directory...' : 'Select a file...';
    const description = seedType === 'directory'
        ? 'Select a directory to share with all its contents via P2P.'
        : 'Select a file to share via P2P.';
    const browseBtnText = seedType === 'directory' ? 'Browse Folder' : 'Browse File';

    document.getElementById('seed-path').placeholder = placeholder;
    document.getElementById('seed-type-description').textContent = description;
    document.getElementById('browse-btn-text').textContent = browseBtnText;
}

// ==================== Settings Functions ====================

async function loadSettings() {
    try {
        const response = await fetch('/api/settings');
        const result = await response.json();
        if (result.success) {
            currentSettings = result.settings;
            populateSettingsForm(currentSettings);
        }
    } catch (err) {
        console.error('Failed to load settings:', err);
    }
}

function populateSettingsForm(settings) {
    // General
    document.getElementById('setting-download-path').value = settings.downloadPath || './downloads';
    document.getElementById('setting-seed-path').value = settings.seedPath || './nectar-data';
    document.getElementById('setting-auto-start').checked = settings.autoStartDownloads || true;

    // Network
    document.getElementById('setting-port').value = settings.port || 3000;
    document.getElementById('setting-max-connections').value = settings.maxConnections || 100;
    document.getElementById('setting-enable-dht').checked = settings.enableDHT !== false;

    // Limits
    document.getElementById('setting-max-download').value = settings.maxDownloadSpeed || 0;
    document.getElementById('setting-max-upload').value = settings.maxUploadSpeed || 0;
    document.getElementById('setting-max-concurrent').value = settings.maxConcurrentDownloads || 3;

    // UI
    document.getElementById('setting-theme').value = settings.theme || 'dark';
    document.getElementById('setting-notify-download').checked = settings.notifyOnDownloadComplete !== false;
    document.getElementById('setting-notify-peer').checked = settings.notifyOnPeerConnect || false;
}

async function saveSettings() {
    const newSettings = {
        // General
        downloadPath: document.getElementById('setting-download-path').value,
        seedPath: document.getElementById('setting-seed-path').value,
        autoStartDownloads: document.getElementById('setting-auto-start').checked,

        // Network
        port: parseInt(document.getElementById('setting-port').value),
        maxConnections: parseInt(document.getElementById('setting-max-connections').value),
        enableDHT: document.getElementById('setting-enable-dht').checked,

        // Limits
        maxDownloadSpeed: parseInt(document.getElementById('setting-max-download').value),
        maxUploadSpeed: parseInt(document.getElementById('setting-max-upload').value),
        maxConcurrentDownloads: parseInt(document.getElementById('setting-max-concurrent').value),

        // UI
        theme: document.getElementById('setting-theme').value,
        notifyOnDownloadComplete: document.getElementById('setting-notify-download').checked,
        notifyOnPeerConnect: document.getElementById('setting-notify-peer').checked
    };

    try {
        const response = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newSettings)
        });
        const result = await response.json();

        if (result.success) {
            currentSettings = result.settings;
            showToast('Settings saved successfully!', 'success', 3000);
            closeModal('settings');
        } else {
            showToast(result.error, 'error');
        }
    } catch (err) {
        showToast('Failed to save settings', 'error');
    }
}

async function resetSettings() {
    if (!confirm('Are you sure you want to reset all settings to defaults?')) return;

    try {
        const response = await fetch('/api/settings/reset', {
            method: 'POST'
        });
        const result = await response.json();

        if (result.success) {
            populateSettingsForm(result.settings);
            showToast('Settings reset to defaults', 'info', 3000);
        } else {
            showToast(result.error, 'error');
        }
    } catch (err) {
        showToast('Failed to reset settings', 'error');
    }
}

async function browseDownloadPath() {
    const dirPath = await window.electronAPI.selectDirectory();
    if (dirPath) {
        document.getElementById('setting-download-path').value = dirPath;
    }
}

async function loadMyPublicKey() {
    try {
        const response = await fetch('/api/ratings/my-public-key');
        const result = await response.json();
        if (result.success) {
            myPublicKey = result.publicKey;
            console.log('[Rating] My public key:', myPublicKey.slice(0, 16) + '...');
        }
    } catch (err) {
        console.error('Failed to load public key:', err);
    }
}

async function loadSeederKey(torrentKey) {
    try {
        const response = await fetch(`/api/ratings/seeder-key/${torrentKey}`);
        const result = await response.json();
        if (result.success && result.seederKey) {
            seederKeys.set(torrentKey, result.seederKey);
            return result.seederKey;
        }
    } catch (err) {
        console.error('Failed to load seeder key:', err);
    }
    return null;
}

function isOwnSeeder(torrentKey) {
    const seederKey = seederKeys.get(torrentKey);
    return seederKey && seederKey === myPublicKey;
}

async function fetchRating(peerKey) {
    try {
        const response = await fetch(`/api/ratings/${peerKey}`);
        const result = await response.json();
        if (result.success && result.rating) {
            return {
                trustScore: calculateTrustScore(result.rating),
                averageSpeed: result.rating.averageSpeed,
                averageReliability: result.rating.averageReliability,
                totalRatings: result.rating.totalRatings
            };
        }
    } catch (err) {
        console.error('Failed to fetch rating:', err);
    }
    return null;
}

function calculateTrustScore(rating) {
    if (!rating || rating.totalRatings === 0) return 50;
    let score = (rating.averageSpeed + rating.averageReliability) / 2 * 10;
    return Math.max(0, Math.min(100, Math.round(score)));
}

function renderMiniStars(rating) {
    if (!rating) return '';
    const fullStars = Math.floor(rating);
    const hasHalf = rating % 1 >= 0.5;
    let html = '<div class="star-rating mini">';

    for (let i = 0; i < fullStars; i++) {
        html += '<i class="fa-solid fa-star"></i>';
    }
    if (hasHalf) {
        html += '<i class="fa-solid fa-star-half-stroke"></i>';
    }
    for (let i = fullStars + (hasHalf ? 1 : 0); i < 5; i++) {
        html += '<i class="fa-regular fa-star"></i>';
    }

    return html + '</div>';
}

// Tab switching for settings
document.addEventListener('DOMContentLoaded', () => {
    // Load my public key for rating validation
    loadMyPublicKey();
    // Load settings on startup
    loadSettings();
    // Initialize Ratings UI listeners
    initRatingsUI();

    const tabs = document.querySelectorAll('.settings-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const target = tab.dataset.tab;
            document.querySelectorAll('.settings-section').forEach(section => {
                section.style.display = section.id === `settings-${target}` ? 'block' : 'none';
            });
        });
    });

    // Sidebar navigation
    document.querySelectorAll('nav li').forEach(li => {
        li.addEventListener('click', () => {
            const text = li.textContent.trim().toLowerCase();
            if (text.includes('transfers')) {
                showTransfersView();
            } else if (text.includes('search')) {
                showSearchView();
            }
        });
    });

    // Load settings when settings modal is opened
    const settingsModal = document.getElementById('modal-settings');
    const originalOpenModal = openModal;
    openModal = function (type) {
        originalOpenModal(type);
        if (type === 'settings') {
            loadSettings();
        }
    };

    // Initial load
    loadTorrents();
    setInterval(loadTorrents, 5000);
});

// View switching
function showSearchView() {
    document.getElementById('torrent-list').style.display = 'none';
    document.getElementById('search-view').style.display = 'block';

    // Update sidebar active state
    document.querySelectorAll('nav li').forEach(li => li.classList.remove('active'));
    document.getElementById('nav-search').classList.add('active');
}

function showTransfersView() {
    document.getElementById('torrent-list').style.display = 'grid';
    document.getElementById('search-view').style.display = 'none';

    // Update sidebar active state
    document.querySelectorAll('nav li').forEach(li => li.classList.remove('active'));
    document.querySelectorAll('nav li')[0].classList.add('active'); // Transfers is first
}

async function handleSearch() {
    const input = document.getElementById('search-input');
    const query = input.value.trim();
    if (!query) return;

    const resultsContainer = document.getElementById('search-results');
    resultsContainer.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 4rem;"><i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; margin-bottom: 1rem;"></i><p>Searching the network...</p></div>';

    try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const data = await response.json();

        if (data.results && data.results.length > 0) {
            renderSearchResults(data.results);
        } else {
            resultsContainer.innerHTML = '<div class="empty-state" style="grid-column: 1/-1; text-align: center; color: var(--text-secondary); padding: 4rem;"><i class="fa-solid fa-magnifying-glass" style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.3;"></i><p>No files found. Try another search term.</p></div>';
        }
    } catch (err) {
        showToast('Search failed: ' + err.message, 'error');
    }
}

function renderSearchResults(results) {
    const container = document.getElementById('search-results');
    container.innerHTML = '';

    results.forEach(res => {
        const card = document.createElement('div');
        card.className = 'torrent-card search-result-card';
        card.innerHTML = `
            <div class="torrent-info">
                <div class="torrent-name">${res.name}</div>
                <div class="torrent-meta">
                    <span><i class="fa-solid fa-file"></i> ${res.fileCount} files</span>
                    <span>${formatBytes(res.size)}</span>
                </div>
                <div class="peer-key-small">Shared by: ${res.peerKey.slice(0, 8)}...</div>
            </div>
            <div style="margin-top: auto; padding-top: 1rem;">
                <button class="btn-primary" style="width: 100%; justify-content: center;" onclick="quickDownload('${res.key}')">
                    <i class="fa-solid fa-download"></i> Download
                </button>
            </div>
        `;
        container.appendChild(card);
    });
}

function quickDownload(key) {
    openModal('download');
    setTimeout(() => {
        const input = document.getElementById('download-key');
        if (input) {
            input.value = key;
            // Optionally auto-trigger download if we're sure
            // handleDownload(); 
        }
    }, 100);
}

// ==================== Ratings Functions ====================

function initRatingsUI() {
    // Ratings tab switching
    const ratingsTabs = document.querySelectorAll('.ratings-tab');
    ratingsTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;

            ratingsTabs.forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.ratings-tab-content').forEach(c => c.classList.remove('active'));

            tab.classList.add('active');
            document.getElementById(`ratings-${tabName}`).classList.add('active');

            if (tabName === 'top') {
                loadTopPeers();
            } else if (tabName === 'all') {
                loadAllRatings();
            }
        });
    });

    // Star rating interaction for speed
    const speedStars = document.querySelectorAll('#speed-rating i');
    speedStars.forEach(star => {
        star.addEventListener('click', () => {
            const value = parseInt(star.dataset.value);
            document.getElementById('speed-value').value = value;
            updateStarDisplay('speed-rating', value);
        });
    });

    // Star rating interaction for reliability
    const reliabilityStars = document.querySelectorAll('#reliability-rating i')
    reliabilityStars.forEach(star => {
        star.addEventListener('click', () => {
            const value = parseInt(star.dataset.value);
            document.getElementById('reliability-value').value = value;
            updateStarDisplay('reliability-rating', value);
        });
    });
}

function updateStarDisplay(containerId, value) {
    const stars = document.querySelectorAll(`#${containerId} i`);
    stars.forEach(star => {
        const starValue = parseInt(star.dataset.value);
        if (starValue <= value) {
            star.classList.remove('fa-regular');
            star.classList.add('fa-solid', 'active');
        } else {
            star.classList.remove('fa-solid', 'active');
            star.classList.add('fa-regular');
        }
    });
}

async function loadRatings() {
    try {
        const response = await fetch('/api/ratings');
        const result = await response.json();

        if (result.success) {
            updateRatingsStats(result.ratings);
        }
    } catch (err) {
        console.error('Failed to load ratings:', err);
    }
}

function updateRatingsStats(ratings) {
    const totalPeers = ratings.length;
    const totalRatings = ratings.reduce((sum, r) => sum + r.totalRatings, 0);

    document.getElementById('total-peers').textContent = totalPeers;
    document.getElementById('total-ratings').textContent = totalRatings;
}

async function loadTopPeers() {
    try {
        const response = await fetch('/api/ratings/top?limit=10');
        const result = await response.json();

        const container = document.getElementById('top-peers-list');

        if (result.success && result.top.length > 0) {
            container.innerHTML = result.top.map((peer, index) => renderPeerCard(peer, index + 1)).join('');
        } else {
            container.innerHTML = `
                <div class="empty-state" style="padding: 3rem; text-align: center;">
                    <i class="fa-solid fa-trophy" style="font-size: 3rem; opacity: 0.3; margin-bottom: 1rem;"></i>
                    <p>No ratings yet. Start rating peers after downloads!</p>
                </div>
            `;
        }
    } catch (err) {
        console.error('Failed to load top peers:', err);
        document.getElementById('top-peers-list').innerHTML = '<div class="diff-error">Failed to load ratings</div>';
    }
}

async function loadAllRatings() {
    try {
        const response = await fetch('/api/ratings');
        const result = await response.json();

        const container = document.getElementById('all-ratings-list');

        if (result.success && result.ratings.length > 0) {
            container.innerHTML = result.ratings.map((peer, index) => renderPeerCard(peer, index + 1, true)).join('');
        } else {
            container.innerHTML = `
                <div class="empty-state" style="padding: 3rem; text-align: center;">
                    <i class="fa-solid fa-list" style="font-size: 3rem; opacity: 0.3; margin-bottom: 1rem;"></i>
                    <p>No ratings stored</p>
                </div>
            `;
        }
    } catch (err) {
        console.error('Failed to load all ratings:', err);
        document.getElementById('all-ratings-list').innerHTML = '<div class="diff-error">Failed to load ratings</div>';
    }
}

function renderPeerCard(peer, rank, showAll = false) {
    const trustLevel = getTrustLevel(peer.trustScore);
    const shortKey = peer.peerKey.slice(0, 12) + '...' + peer.peerKey.slice(-8);

    return `
        <div class="peer-card">
            <div class="peer-rank">#${rank}</div>
            <div class="peer-info">
                <div class="peer-key" title="${peer.peerKey}">${shortKey}</div>
                <div class="star-rating">
                    ${renderStars(peer.averageSpeed || 0)}
                    <span style="color: var(--text-secondary); font-size: 0.75rem; margin-left: 5px;">
                        ${peer.averageSpeed?.toFixed(1) || '0'}/5 speed
                    </span>
                </div>
                <div class="peer-stats">
                    <span><i class="fa-solid fa-upload"></i> ${peer.uploads || 0}</span>
                    <span><i class="fa-solid fa-download"></i> ${peer.downloads || 0}</span>
                    <span><i class="fa-solid fa-file-contract"></i> ${peer.totalRatings || 0} ratings</span>
                </div>
                ${peer.ratings && peer.ratings.length > 0 && peer.ratings[peer.ratings.length - 1].comment ? `
                    <div class="rating-comment">"${peer.ratings[peer.ratings.length - 1].comment}"</div>
                ` : ''}
            </div>
            <div class="trust-badge trust-${trustLevel}">
                ${peer.trustScore}% trust
            </div>
        </div>
    `;
}

function renderStars(rating) {
    const fullStars = Math.floor(rating);
    const hasHalf = rating % 1 >= 0.5;
    let html = '';

    for (let i = 0; i < fullStars; i++) {
        html += '<i class="fa-solid fa-star"></i>';
    }
    if (hasHalf) {
        html += '<i class="fa-solid fa-star-half-stroke"></i>';
    }
    for (let i = fullStars + (hasHalf ? 1 : 0); i < 5; i++) {
        html += '<i class="fa-regular fa-star"></i>';
    }

    return html;
}

function getTrustLevel(score) {
    if (score >= 70) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
}

async function openRateModal(peerKey) {
    // Открываем модалку рейтингов и переключаемся на вкладку Rate
    openModal('ratings');

    // Заполняем поле ключом
    document.getElementById('rate-peer-key').value = peerKey;

    // Переключаем на вкладку Rate
    const rateTab = document.querySelector('.ratings-tab[data-tab="rate"]');
    rateTab.click();

    showToast('Rate this peer!', 'info', 2000);
}

async function submitRating() {
    const peerKey = document.getElementById('rate-peer-key').value.trim();
    const speed = parseInt(document.getElementById('speed-value').value);
    const reliability = parseInt(document.getElementById('reliability-value').value);
    const comment = document.getElementById('rate-comment').value.trim();

    if (!peerKey) {
        showToast('Please enter a peer key', 'warning');
        return;
    }

    if (peerKey.length !== 64) {
        showToast('Peer key must be 64 characters', 'warning');
        return;
    }

    // Проверяем, не оцениваем ли мы свою же раздачу
    if (peerKey === myPublicKey) {
        showToast('Cannot rate your own seed!', 'warning');
        return;
    }

    if (speed === 0 || reliability === 0) {
        showToast('Please rate both speed and reliability', 'warning');
        return;
    }

    try {
        const response = await fetch('/api/ratings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                peerKey,
                speed,
                reliability,
                comment
            })
        });

        const result = await response.json();

        if (result.success) {
            showToast('Rating submitted successfully!', 'success', 3000);

            // Reset form
            document.getElementById('rate-peer-key').value = '';
            document.getElementById('speed-value').value = 0;
            document.getElementById('reliability-value').value = 0;
            document.getElementById('rate-comment').value = '';
            updateStarDisplay('speed-rating', 0);
            updateStarDisplay('reliability-rating', 0);

            // Reload ratings
            loadRatings();

            // Перерисовываем торренты чтобы обновить рейтинг
            ws.send(JSON.stringify({ type: 'refresh' }));
        } else {
            showToast(result.error, 'error');
        }
    } catch (err) {
        showToast('Failed to submit rating', 'error');
    }
}

async function exportRatings() {
    try {
        const response = await fetch('/api/ratings/export');
        const result = await response.json();

        if (result.success) {
            const blob = new Blob([JSON.stringify(result.ratings, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `nectar-ratings-${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('Ratings exported successfully!', 'success', 3000);
        } else {
            showToast(result.error, 'error');
        }
    } catch (err) {
        showToast('Failed to export ratings', 'error');
    }
}

// Override openModal to load ratings when modal opens
const originalOpenModal = window.openModal;
window.openModal = function (type) {
    originalOpenModal(type);
    if (type === 'ratings') {
        loadRatings();
    }
};

window.onclick = function (event) {
    if (event.target.className === 'modal') {
        event.target.style.display = 'none';
    }
};
