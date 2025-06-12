// Worker API Base URL (REPLACE THIS WITH YOUR ACTUAL WORKER URL AFTER DEPLOYMENT)
const WORKER_BASE_URL = "https://axel-drive.comtv.workers.dev"; 
const app = document.getElementById('app');
let adminToken = localStorage.getItem('admin_token');

// --- Helper Functions ---

async function apiRequest(endpoint, method = 'GET', body = null, requiresAuth = true) {
    const headers = {
        'Content-Type': 'application/json',
    };

    if (requiresAuth && !adminToken) {
        alert('Authentication required. Please login.');
        showLoginPage(); // Redirect to login
        throw new Error('Authentication required');
    }
    if (requiresAuth && adminToken) {
        headers['Authorization'] = `Bearer ${adminToken}`;
    }

    const options = { method, headers };
    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(`${WORKER_BASE_URL}${endpoint}`, options);
    const data = await response.json();

    if (!response.ok) {
        console.error('API Error:', data.error || response.statusText);
        throw new Error(data.error || 'API request failed');
    }
    return data;
}

function showMessage(message, type = 'success') {
    const messageDiv = document.createElement('div');
    messageDiv.className = type === 'error' ? 'error-message' : 'success-message';
    messageDiv.textContent = message;
    app.prepend(messageDiv);
    setTimeout(() => messageDiv.remove(), 5000); // Remove after 5 seconds
}

// --- UI Rendering Functions ---

// 1. Login Page
function showLoginPage() {
    app.innerHTML = `
        <h2>Admin Login</h2>
        <div class="form-group">
            <label for="username">Username:</label>
            <input type="text" id="username" placeholder="admin">
        </div>
        <div class="form-group">
            <label for="password">Password:</label>
            <input type="password" id="password" placeholder="123admin">
        </div>
        <button id="loginBtn" class="btn btn-primary">Login</button>
    `;

    document.getElementById('loginBtn').onclick = async () => {
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        try {
            const data = await apiRequest('/api/auth/login', 'POST', { username, password }, false); // No auth needed for login
            adminToken = data.token;
            localStorage.setItem('admin_token', adminToken);
            showMessage('Login successful!');
            showGoogleAccountsPage(); // Go to accounts list after login
        } catch (error) {
            showMessage(`Login failed: ${error.message}`, 'error');
        }
    };
}

// 2. Google Drive Accounts List Page
async function showGoogleAccountsPage() {
    if (!adminToken) {
        showLoginPage();
        return;
    }

    app.innerHTML = `
        <h2>Google Drive Accounts</h2>
        <button id="addAccountBtn" class="btn btn-primary" style="margin-bottom: 15px;">+ Add New Account</button>
        <div id="accountsList">Loading accounts...</div>
    `;

    document.getElementById('addAccountBtn').onclick = () => showAddEditAccountPage();

    try {
        const accounts = await apiRequest('/api/settings/list');
        const accountsListDiv = document.getElementById('accountsList');
        accountsListDiv.innerHTML = ''; // Clear loading message

        if (accounts.length === 0) {
            accountsListDiv.textContent = 'No Google Drive accounts added yet.';
            return;
        }

        accounts.forEach(account => {
            const accountDiv = document.createElement('div');
            accountDiv.className = 'list-item';
            accountDiv.innerHTML = `
                <span class="list-item-name">${account.name} (ID: ${account.id})</span>
                <div class="list-item-actions">
                    <button class="btn btn-secondary view-btn" data-id="${account.id}">View</button>
                    <button class="btn btn-secondary edit-btn" data-id="${account.id}">Edit</button>
                    <button class="btn btn-danger delete-btn" data-id="${account.id}">Delete</button>
                </div>
            `;
            accountsListDiv.appendChild(accountDiv);
        });

        accountsListDiv.querySelectorAll('.view-btn').forEach(button => {
            button.onclick = (e) => showDriveBrowserPage(e.target.dataset.id);
        });
        accountsListDiv.querySelectorAll('.edit-btn').forEach(button => {
            button.onclick = (e) => showAddEditAccountPage(e.target.dataset.id);
        });
        accountsListDiv.querySelectorAll('.delete-btn').forEach(button => {
            button.onclick = async (e) => {
                if (confirm(`Are you sure you want to delete account "${e.target.dataset.id}"?`)) {
                    try {
                        await apiRequest(`/api/settings/delete/${e.target.dataset.id}`, 'DELETE');
                        showMessage('Account deleted successfully!');
                        showGoogleAccountsPage(); // Refresh list
                    } catch (error) {
                        showMessage(`Failed to delete account: ${error.message}`, 'error');
                    }
                }
            };
        });

    } catch (error) {
        showMessage(`Failed to load accounts: ${error.message}`, 'error');
        // If auth failed, show login page
        if (error.message.includes('Authentication required')) {
            showLoginPage();
        }
    }
}

// 3. Add/Edit Google Drive Account Page
async function showAddEditAccountPage(accountId = null) {
    if (!adminToken) {
        showLoginPage();
        return;
    }

    let account = {};
    if (accountId) {
        try {
            account = await apiRequest(`/api/settings/get/${accountId}`);
        } catch (error) {
            showMessage(`Failed to load account for editing: ${error.message}`, 'error');
            return;
        }
    }

    app.innerHTML = `
        <h2>${accountId ? 'Edit' : 'Add'} Google Drive Account</h2>
        <div class="form-group">
            <label for="accountId">Account ID (Unique Identifier):</label>
            <input type="text" id="accountId" value="${account.id || ''}" ${accountId ? 'readonly' : ''}>
        </div>
        <div class="form-group">
            <label for="accountName">Account Name:</label>
            <input type="text" id="accountName" value="${account.name || ''}">
        </div>
        <div class="form-group">
            <label for="clientId">Client ID:</label>
            <input type="text" id="clientId" value="${account.client_id || ''}">
        </div>
        <div class="form-group">
            <label for="clientSecret">Client Secret:</label>
            <input type="text" id="clientSecret" value="${account.client_secret || ''}">
        </div>
        <div class="form-group">
            <label for="refreshToken">Refresh Token:</label>
            <input type="text" id="refreshToken" value="${account.refresh_token || ''}">
        </div>
        <button id="saveAccountBtn" class="btn btn-primary">Save Account</button>
        <button id="cancelBtn" class="btn btn-secondary">Cancel</button>
    `;

    document.getElementById('saveAccountBtn').onclick = async () => {
        const id = document.getElementById('accountId').value;
        const name = document.getElementById('accountName').value;
        const client_id = document.getElementById('clientId').value;
        const client_secret = document.getElementById('clientSecret').value;
        const refresh_token = document.getElementById('refreshToken').value;

        const data = { id, name, client_id, client_secret, refresh_token };

        try {
            if (accountId) {
                await apiRequest(`/api/settings/update/${id}`, 'PUT', data);
                showMessage('Account updated successfully!');
            } else {
                await apiRequest('/api/settings/add', 'POST', data);
                showMessage('Account added successfully!');
            }
            showGoogleAccountsPage(); // Go back to accounts list
        } catch (error) {
            showMessage(`Failed to save account: ${error.message}`, 'error');
        }
    };

    document.getElementById('cancelBtn').onclick = () => showGoogleAccountsPage();
}

// 4. Google Drive File/Folder Browser Page
async function showDriveBrowserPage(accountId, folderId = null, searchTerm = null, pageToken = null) {
    if (!adminToken) {
        showLoginPage();
        return;
    }

    app.innerHTML = `
        <h2 id="browserTitle">Loading Drive...</h2>
        <button id="backToAccountsBtn" class="btn btn-secondary">Back to Accounts</button>
        <div style="margin-top: 15px;">
            <input type="text" id="searchDriveInput" placeholder="Search files and folders..." value="${searchTerm || ''}" style="width: 70%; margin-right: 10px;">
            <button id="searchDriveBtn" class="btn btn-primary">Search</button>
            <button id="clearSearchBtn" class="btn btn-secondary">Clear Search</button>
        </div>
        <div id="driveContent" style="margin-top: 20px;">Loading content...</div>
        <div id="pagination" style="margin-top: 20px; text-align: center;"></div>
        <div id="mediaPlayerContainer" style="margin-top: 20px;"></div>
    `;

    document.getElementById('backToAccountsBtn').onclick = () => showGoogleAccountsPage();
    document.getElementById('searchDriveBtn').onclick = () => {
        const query = document.getElementById('searchDriveInput').value;
        showDriveBrowserPage(accountId, null, query); // Start new search from root of current account
    };
    document.getElementById('clearSearchBtn').onclick = () => {
        document.getElementById('searchDriveInput').value = '';
        showDriveBrowserPage(accountId, folderId); // Clear search and reload current folder
    };

    const browserTitle = document.getElementById('browserTitle');
    const driveContentDiv = document.getElementById('driveContent');
    const paginationDiv = document.getElementById('pagination');
    const mediaPlayerContainer = document.getElementById('mediaPlayerContainer');

    try {
        let apiUrl;
        let queryParams = new URLSearchParams();
        queryParams.append('pageSize', 50); // Set a default page size for UI

        if (searchTerm) {
            browserTitle.textContent = `Search Results for "${searchTerm}"`;
            apiUrl = `/api/drive/search/${accountId}`;
            queryParams.append('q', searchTerm);
        } else {
            browserTitle.textContent = `Browse Drive (Account: ${accountId})` + (folderId ? ` - Folder: ${folderId}` : '');
            apiUrl = `/api/drive/list/${accountId}/${folderId || ''}`; // If folderId is null, API will use root
        }

        if (pageToken) {
            queryParams.append('pageToken', pageToken);
        }

        const data = await apiRequest(`${apiUrl}?${queryParams.toString()}`);
        driveContentDiv.innerHTML = ''; // Clear loading message

        if (data.files && data.files.length === 0) {
            driveContentDiv.textContent = searchTerm ? 'No search results found.' : 'This folder is empty.';
            return;
        }

        data.files.forEach(item => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'list-item';
            
            let icon = '';
            if (item.mimeType === CONSTS.folder_mime_type) {
                icon = '📁'; // Folder icon
            } else if (item.mimeType.startsWith('video/')) {
                icon = '🎬'; // Video icon
            } else if (item.mimeType.startsWith('audio/')) {
                icon = '🎵'; // Audio icon
            } else if (item.mimeType.startsWith('image/')) {
                icon = '🖼️'; // Image icon
            } else {
                icon = '📄'; // Generic file icon
            }

            itemDiv.innerHTML = `
                <span class="list-item-name">${icon} ${item.name}</span>
                <div class="list-item-actions">
                    ${item.mimeType !== CONSTS.folder_mime_type ? `<button class="btn btn-secondary copy-link-btn" data-account-id="${accountId}" data-file-id="${item.id}">Copy Link</button>` : ''}
                    ${(item.mimeType.startsWith('video/') || item.mimeType.startsWith('audio/')) ? `<button class="btn btn-primary play-btn" data-account-id="${accountId}" data-file-id="${item.id}" data-mime-type="${item.mimeType}">Play</button>` : ''}
                    ${item.mimeType === CONSTS.folder_mime_type ? `<button class="btn btn-primary browse-folder-btn" data-account-id="${accountId}" data-folder-id="${item.id}">Browse</button>` : ''}
                </div>
            `;
            driveContentDiv.appendChild(itemDiv);
        });

        // Pagination buttons
        paginationDiv.innerHTML = '';
        if (data.nextPageToken) {
            const loadMoreBtn = document.createElement('button');
            loadMoreBtn.className = 'btn btn-secondary';
            loadMoreBtn.textContent = 'Load More';
            loadMoreBtn.onclick = () => showDriveBrowserPage(accountId, folderId, searchTerm, data.nextPageToken);
            paginationDiv.appendChild(loadMoreBtn);
        }

        // Event listeners for file/folder actions
        driveContentDiv.querySelectorAll('.browse-folder-btn').forEach(button => {
            button.onclick = (e) => showDriveBrowserPage(e.target.dataset.accountId, e.target.dataset.folderId);
        });

        driveContentDiv.querySelectorAll('.copy-link-btn').forEach(button => {
            button.onclick = async (e) => {
                const link = `${WORKER_BASE_URL}/api/drive/download/${e.target.dataset.accountId}/${e.target.dataset.fileId}`;
                try {
                    await navigator.clipboard.writeText(link);
                    showMessage('Direct link copied to clipboard!');
                } catch (err) {
                    showMessage('Failed to copy link. Please copy manually.', 'error');
                    console.error('Copy error:', err);
                }
            };
        });

        driveContentDiv.querySelectorAll('.play-btn').forEach(button => {
            button.onclick = (e) => {
                const fileId = e.target.dataset.fileId;
                const mimeType = e.target.dataset.mimeType;
                const streamUrl = `${WORKER_BASE_URL}/api/drive/download/${accountId}/${fileId}`;
                
                mediaPlayerContainer.innerHTML = ''; // Clear previous player
                if (mimeType.startsWith('video/')) {
                    mediaPlayerContainer.innerHTML = `
                        <h3>Video Player</h3>
                        <video controls class="video-player">
                            <source src="${streamUrl}" type="${mimeType}">
                            Your browser does not support the video tag.
                        </video>
                    `;
                } else if (mimeType.startsWith('audio/')) {
                    mediaPlayerContainer.innerHTML = `
                        <h3>Audio Player</h3>
                        <audio controls class="audio-player">
                            <source src="${streamUrl}" type="${mimeType}">
                            Your browser does not support the audio tag.
                        </audio>
                    `;
                }
            };
        });

    } catch (error) {
        showMessage(`Failed to load drive content: ${error.message}`, 'error');
        if (error.message.includes('Authentication required')) {
            showLoginPage();
        }
    }
}

// Initial page load check
document.addEventListener('DOMContentLoaded', () => {
    if (adminToken) {
        showGoogleAccountsPage();
    } else {
        showLoginPage();
    }
});

// A simple way to handle browser back/forward (optional, for full SPA routing)
window.onpopstate = () => {
    // You'd need more sophisticated routing here if using history.pushState
    // For now, it just reloads based on current state (likely not working perfectly with above direct calls)
    // A full SPA framework handles this better.
};