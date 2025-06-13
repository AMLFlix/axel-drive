// Worker API Base URL (REPLACE THIS WITH YOUR ACTUAL WORKER URL AFTER DEPLOYMENT)
const WORKER_BASE_URL = "https://axel-drive.comtv.workers.dev";
const app = document.getElementById('app');
const loadingOverlay = document.getElementById('loadingOverlay');
const logoutBtn = document.getElementById('logoutBtn');
let adminToken = localStorage.getItem('admin_token');

const CONSTS = {
    folder_mime_type: "application/vnd.google-apps.folder",
};

// --- Helper Functions ---

function showLoading() {
    loadingOverlay.classList.add('visible');
}

function hideLoading() {
    loadingOverlay.classList.remove('visible');
}

async function apiRequest(endpoint, method = 'GET', body = null, requiresAuth = true) {
    showLoading();
    const headers = {
        'Content-Type': 'application/json',
    };

    if (requiresAuth && !adminToken) {
        showMessage('Authentication required. Please login.', 'error');
        showLoginPage();
        hideLoading();
        throw new Error('Authentication required');
    }
    if (requiresAuth && adminToken) {
        headers['Authorization'] = `Bearer ${adminToken}`;
    }

    const options = { method, headers };
    if (body) {
        options.body = JSON.stringify(body);
    }

    try {
        const response = await fetch(`${WORKER_BASE_URL}${endpoint}`, options);
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'API request failed');
        }
        return data;
    } catch (error) {
        console.error('API Error:', error);
        showMessage(error.message, 'error');
        throw error;
    } finally {
        hideLoading();
    }
}

function showMessage(message, type = 'success') {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}-message`;
    messageDiv.textContent = message;
    document.body.appendChild(messageDiv);
    setTimeout(() => messageDiv.remove(), 5000);
}

function handleLogout() {
    localStorage.removeItem('admin_token');
    adminToken = null;
    showMessage('You have been logged out.');
    showLoginPage();
}

// --- UI Rendering Functions ---

// 1. Login Page
function showLoginPage() {
    logoutBtn.style.display = 'none';
    app.innerHTML = `
        <div class="card" style="max-width: 400px; margin: 40px auto;">
            <h2><i class="fas fa-lock"></i> Admin Login</h2>
            <div class="form-group">
                <label for="username">Username:</label>
                <input type="text" id="username" placeholder="admin">
            </div>
            <div class="form-group">
                <label for="password">Password:</label>
                <input type="password" id="password" placeholder="••••••••">
            </div>
            <button id="loginBtn" class="btn btn-primary" style="width: 100%;">
                <i class="fas fa-sign-in-alt"></i> Login
            </button>
        </div>
    `;

    document.getElementById('loginBtn').onclick = async () => {
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        try {
            const data = await apiRequest('/api/auth/login', 'POST', { username, password }, false);
            adminToken = data.token;
            localStorage.setItem('admin_token', adminToken);
            showMessage('Login successful!');
            showGoogleAccountsPage();
        } catch (error) {
            // Error message is already shown by apiRequest
        }
    };
}

// 2. Google Drive Accounts List Page
async function showGoogleAccountsPage() {
    if (!adminToken) {
        showLoginPage();
        return;
    }
    logoutBtn.style.display = 'flex';
    app.innerHTML = `
        <h2><i class="fab fa-google-drive"></i> Google Drive Accounts</h2>
        <button id="addAccountBtn" class="btn btn-primary" style="margin-bottom: 24px;">
            <i class="fas fa-plus"></i> Add New Account
        </button>
        <div id="accountsList"></div>
    `;

    document.getElementById('addAccountBtn').onclick = () => showAddEditAccountPage();

    try {
        const accounts = await apiRequest('/api/settings/list');
        const accountsListDiv = document.getElementById('accountsList');
        accountsListDiv.innerHTML = '';

        if (accounts.length === 0) {
            accountsListDiv.innerHTML = '<div class="card"><p>No Google Drive accounts added yet.</p></div>';
            return;
        }

        accounts.forEach(account => {
            const accountDiv = document.createElement('div');
            accountDiv.className = 'list-item';
            accountDiv.innerHTML = `
                <span class="list-item-name">
                    <i class="fas fa-user-circle"></i>
                    ${account.name} (ID: ${account.id})
                </span>
                <div class="list-item-actions">
                    <button class="btn btn-secondary view-btn" data-id="${account.id}"><i class="fas fa-folder-open"></i> View</button>
                    <button class="btn btn-secondary edit-btn" data-id="${account.id}"><i class="fas fa-edit"></i> Edit</button>
                    <button class="btn btn-danger delete-btn" data-id="${account.id}"><i class="fas fa-trash"></i> Delete</button>
                </div>
            `;
            accountsListDiv.appendChild(accountDiv);
        });

        accountsListDiv.querySelectorAll('.view-btn').forEach(b => b.onclick = (e) => showDriveBrowserPage(e.currentTarget.dataset.id));
        accountsListDiv.querySelectorAll('.edit-btn').forEach(b => b.onclick = (e) => showAddEditAccountPage(e.currentTarget.dataset.id));
        accountsListDiv.querySelectorAll('.delete-btn').forEach(b => {
            b.onclick = (e) => {
                const accountId = e.currentTarget.dataset.id;
                showConfirmModal(`Are you sure you want to delete account "${accountId}"?`, async () => {
                    try {
                        await apiRequest(`/api/settings/delete/${accountId}`, 'DELETE');
                        showMessage('Account deleted successfully!');
                        showGoogleAccountsPage();
                    } catch (error) {
                       // Error message handled by apiRequest
                    }
                });
            };
        });
    } catch (error) {
        if (error.message.includes('Authentication')) showLoginPage();
    }
}

// 3. Add/Edit Account Page
async function showAddEditAccountPage(accountId = null) {
    let account = {};
    if (accountId) {
        try {
            account = await apiRequest(`/api/settings/get/${accountId}`);
        } catch (error) {
            showGoogleAccountsPage();
            return;
        }
    }

    app.innerHTML = `
        <h2><i class="fas fa-cogs"></i> ${accountId ? 'Edit' : 'Add'} Account</h2>
        <div class="card">
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
            <div style="display: flex; gap: 10px; justify-content: flex-end;">
                 <button id="cancelBtn" class="btn btn-secondary">Cancel</button>
                 <button id="saveAccountBtn" class="btn btn-primary"><i class="fas fa-save"></i> Save</button>
            </div>
        </div>
    `;

    document.getElementById('saveAccountBtn').onclick = async () => {
        const payload = {
            id: document.getElementById('accountId').value,
            name: document.getElementById('accountName').value,
            client_id: document.getElementById('clientId').value,
            client_secret: document.getElementById('clientSecret').value,
            refresh_token: document.getElementById('refreshToken').value,
        };
        try {
            if (accountId) {
                await apiRequest(`/api/settings/update/${payload.id}`, 'PUT', payload);
                showMessage('Account updated successfully!');
            } else {
                await apiRequest('/api/settings/add', 'POST', payload);
                showMessage('Account added successfully!');
            }
            showGoogleAccountsPage();
        } catch (error) {
            // Error is handled by apiRequest
        }
    };

    document.getElementById('cancelBtn').onclick = () => showGoogleAccountsPage();
}

// 4. Google Drive File Browser Page
async function showDriveBrowserPage(accountId, folderId = 'root', searchTerm = null, pageToken = null) {
    app.innerHTML = `
        <h2 id="browserTitle">Loading Drive...</h2>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 10px;">
            <button id="backToAccountsBtn" class="btn btn-secondary"><i class="fas fa-arrow-left"></i> Back to Accounts</button>
        </div>
        <div class="search-container">
            <input type="text" id="searchDriveInput" placeholder="Search files and folders in this account..." value="${searchTerm || ''}">
            <button id="searchDriveBtn" class="btn btn-primary"><i class="fas fa-search"></i></button>
            <button id="clearSearchBtn" class="btn btn-secondary">Clear</button>
        </div>
        <div id="driveContent"></div>
        <div id="pagination"></div>
    `;

    document.getElementById('backToAccountsBtn').onclick = () => showGoogleAccountsPage();
    document.getElementById('searchDriveBtn').onclick = () => {
        const query = document.getElementById('searchDriveInput').value;
        if(query) showDriveBrowserPage(accountId, null, query);
    };
    document.getElementById('clearSearchBtn').onclick = () => showDriveBrowserPage(accountId, 'root');

    const browserTitle = document.getElementById('browserTitle');
    const driveContentDiv = document.getElementById('driveContent');
    const paginationDiv = document.getElementById('pagination');

    try {
        let apiUrl, queryParams = new URLSearchParams({ pageSize: 50 });

        if (searchTerm) {
            browserTitle.innerHTML = `<i class="fas fa-search"></i> Search Results for "${searchTerm}"`;
            apiUrl = `/api/drive/search/${accountId}`;
            queryParams.append('q', searchTerm);
        } else {
            browserTitle.innerHTML = `<i class="fas fa-folder-tree"></i> Browse Drive (Account: ${accountId})`;
            apiUrl = `/api/drive/list/${accountId}/${folderId || 'root'}`;
        }
        if (pageToken) queryParams.append('pageToken', pageToken);

        const data = await apiRequest(`${apiUrl}?${queryParams.toString()}`);
        driveContentDiv.innerHTML = '';

        if (!data.files || data.files.length === 0) {
            driveContentDiv.innerHTML = `<div class="card"><p>${searchTerm ? 'No search results found.' : 'This folder is empty.'}</p></div>`;
            return;
        }

        data.files.forEach(item => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'list-item';
            
            let icon;
            if (item.mimeType === CONSTS.folder_mime_type) icon = 'fas fa-folder';
            else if (item.mimeType.startsWith('video/')) icon = 'fas fa-file-video';
            else if (item.mimeType.startsWith('audio/')) icon = 'fas fa-file-audio';
            else if (item.mimeType.startsWith('image/')) icon = 'fas fa-file-image';
            else if (item.mimeType.includes('pdf')) icon = 'fas fa-file-pdf';
            else if (item.mimeType.includes('zip') || item.mimeType.includes('rar')) icon = 'fas fa-file-archive';
            else icon = 'fas fa-file-alt';

            itemDiv.innerHTML = `
                <span class="list-item-name"><i class="${icon}"></i> ${item.name}</span>
                <div class="list-item-actions">
                    ${item.mimeType !== CONSTS.folder_mime_type ? `<button class="btn btn-secondary copy-link-btn" data-account-id="${accountId}" data-file-id="${item.id}"><i class="fas fa-link"></i> Copy Link</button>` : ''}
                    ${(item.mimeType.startsWith('video/')) ? `<button class="btn btn-primary play-btn" data-account-id="${accountId}" data-file-id="${item.id}" data-mime-type="${item.mimeType}" data-file-name="${item.name}"><i class="fas fa-play"></i> Play</button>` : ''}
                    ${item.mimeType === CONSTS.folder_mime_type ? `<button class="btn btn-primary browse-folder-btn" data-account-id="${accountId}" data-folder-id="${item.id}"><i class="fas fa-folder-open"></i> Browse</button>` : ''}
                </div>
            `;
            driveContentDiv.appendChild(itemDiv);
        });
        
        // Add event listeners after creating elements
        driveContentDiv.querySelectorAll('.browse-folder-btn').forEach(b => b.onclick = e => showDriveBrowserPage(e.currentTarget.dataset.accountId, e.currentTarget.dataset.folderId));
        driveContentDiv.querySelectorAll('.copy-link-btn').forEach(b => b.onclick = e => copyToClipboard(e));
        driveContentDiv.querySelectorAll('.play-btn').forEach(b => b.onclick = e => playMediaInModal(e));

        // Pagination
        paginationDiv.innerHTML = '';
        if (data.nextPageToken) {
            const loadMoreBtn = document.createElement('button');
            loadMoreBtn.className = 'btn btn-secondary';
            loadMoreBtn.innerHTML = '<i class="fas fa-chevron-down"></i> Load More';
            loadMoreBtn.onclick = () => showDriveBrowserPage(accountId, folderId, searchTerm, data.nextPageToken);
            paginationDiv.appendChild(loadMoreBtn);
        }
    } catch (error) {
        if (error.message.includes('Authentication')) showLoginPage();
    }
}

// --- Action Helper Functions ---

function copyToClipboard(e) {
    const link = `${WORKER_BASE_URL}/api/drive/download/${e.currentTarget.dataset.accountId}/${e.currentTarget.dataset.fileId}`;
    navigator.clipboard.writeText(link).then(() => {
        showMessage('Direct link copied to clipboard!');
    }, () => {
        showMessage('Failed to copy link.', 'error');
    });
}

function playMediaInModal(e) {
    const { accountId, fileId, mimeType, fileName } = e.currentTarget.dataset;
    const streamUrl = `${WORKER_BASE_URL}/api/drive/download/${accountId}/${fileId}`;

    const modalDiv = document.createElement('div');
    modalDiv.className = 'modal-overlay';
    modalDiv.innerHTML = `
        <div class="modal-content video-modal">
            <h3 style="text-align: left; margin-top: 0;">${fileName}</h3>
            <video controls autoplay class="media-player">
                <source src="${streamUrl}" type="${mimeType}">
                Your browser does not support the video tag.
            </video>
            <div class="modal-actions">
                <button class="btn btn-secondary">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(modalDiv);

    modalDiv.querySelector('.btn-secondary').onclick = () => modalDiv.remove();
    modalDiv.onclick = (event) => {
         if (event.target === modalDiv) {
             modalDiv.remove();
         }
    };
}


function showConfirmModal(message, onConfirm) {
    const modalDiv = document.createElement('div');
    modalDiv.className = 'modal-overlay';
    modalDiv.innerHTML = `
        <div class="modal-content">
            <p>${message}</p>
            <div class="modal-actions">
                <button id="confirmNo" class="btn btn-secondary">No</button>
                <button id="confirmYes" class="btn btn-danger">Yes, Delete</button>
            </div>
        </div>
    `;
    document.body.appendChild(modalDiv);

    document.getElementById('confirmYes').onclick = () => {
        onConfirm();
        modalDiv.remove();
    };
    document.getElementById('confirmNo').onclick = () => modalDiv.remove();
}


// --- Initial Setup ---
document.addEventListener('DOMContentLoaded', () => {
    logoutBtn.onclick = handleLogout;
    if (adminToken) {
        showGoogleAccountsPage();
    } else {
        showLoginPage();
    }
});