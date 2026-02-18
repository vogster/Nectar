const ws = new WebSocket(`ws://${window.location.host}`);
const torrentList = document.getElementById('torrent-list');
const emptyState = torrentList.querySelector('.empty-state');

ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'update') {
        renderTorrents(message.data);
    }
};

function renderTorrents(torrents) {
    if (torrents.length === 0) {
        emptyState.style.display = 'block';
        // Remove existing cards
        const cards = torrentList.querySelectorAll('.torrent-card');
        cards.forEach(c => c.remove());
        return;
    }

    emptyState.style.display = 'none';

    torrents.forEach(torrent => {
        let card = document.getElementById(`torrent-${torrent.key}`);

        if (!card) {
            card = document.createElement('div');
            card.id = `torrent-${torrent.key}`;
            card.className = 'torrent-card';
            torrentList.appendChild(card);
        }

        const typeLabel = torrent.type === 'seeding' ?
            '<i class="fa-solid fa-arrow-up"></i> Seeding' :
            '<i class="fa-solid fa-arrow-down"></i> Downloading';

        card.innerHTML = `
      <div class="torrent-info">
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <div class="torrent-name">${torrent.name}</div>
          <button class="btn-remove" onclick="handleRemove('${torrent.key}')" title="Remove torrent">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
        <div class="torrent-meta">
          <span>${typeLabel}</span>
          <span>${formatBytes(torrent.size)}</span>
        </div>
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
      ${torrent.error ? `<div class="error" style="color: #ff4d4d; font-size: 0.8rem; margin-top: 10px;">${torrent.error}</div>` : ''}
    `;
    });

    // Clean up removed torrents
    const currentKeys = torrents.map(t => `torrent-${t.key}`);
    const cards = torrentList.querySelectorAll('.torrent-card');
    cards.forEach(card => {
        if (!currentKeys.includes(card.id)) card.remove();
    });
}

function copyKey(key) {
    navigator.clipboard.writeText(key);
    alert('Key copied to clipboard!');
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
        if (!result.success) alert('Error: ' + result.error);
    } catch (err) {
        alert('Failed to remove torrent');
    }
}

function resetSeedModal() {
    document.getElementById('seed-result').style.display = 'none';
    document.getElementById('seed-path').value = '';
    document.getElementById('seed-form-content').style.display = 'block';
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
}

function closeModal(type) {
    document.getElementById(`modal-${type}`).style.display = 'none';
}

async function handleSeed() {
    const filePath = document.getElementById('seed-path').value;
    if (!filePath) return alert('Please enter a file path');

    try {
        const response = await fetch('/api/seed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath })
        });
        const result = await response.json();

        if (result.success) {
            document.getElementById('seed-form-content').style.display = 'none';
            document.getElementById('seed-result').style.display = 'block';
            const keyDiv = document.getElementById('generated-key');
            keyDiv.textContent = result.key;
            keyDiv.onclick = () => copyKey(result.key);
        } else {
            alert('Error: ' + result.error);
        }
    } catch (err) {
        alert('Failed to connect to server');
    }
}

async function handleDownload() {
    const key = document.getElementById('download-key').value;
    const savePath = document.getElementById('save-path').value || './downloads';

    if (!key) return alert('Please enter a key');

    try {
        const response = await fetch('/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, savePath })
        });
        const result = await response.json();

        if (result.success) {
            closeModal('download');
        } else {
            alert('Error: ' + result.error);
        }
    } catch (err) {
        alert('Failed to connect to server');
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

window.onclick = function (event) {
    if (event.target.className === 'modal') {
        event.target.style.display = 'none';
    }
};
