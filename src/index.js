// Worker Global Variables
const GOOGLE_AUTH_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

// Helper function to handle JSON responses
async function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        status: status,
    });
}

// Helper function to get access token from refresh token
async function getAccessToken(client_id, client_secret, refresh_token) {
    try {
        const response = await fetch(GOOGLE_AUTH_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                client_id: client_id,
                client_secret: client_secret,
                refresh_token: refresh_token,
                grant_type: 'refresh_token',
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Failed to get access token response:', errorText);
            throw new Error(`Failed to get access token: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        return data.access_token;
    } catch (error) {
        console.error('Error in getAccessToken:', error.message);
        throw error;
    }
}

// Authorization check for admin-only APIs
async function checkAdminAuth(request, env) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return jsonResponse({ error: 'Unauthorized: Missing or invalid token' }, 401);
    }
    const token = authHeader.split(' ')[1];
    if (token !== env.ADMIN_TOKEN) {
        return jsonResponse({ error: 'Unauthorized: Invalid token' }, 401);
    }
    return null; // Authorized
}

// --- API Handlers ---

// Handle Admin Authentication
async function handleAuthLogin(request, env) {
    try {
        const { username, password } = await request.json();
        if (username === env.ADMIN_USERNAME && password === env.ADMIN_PASSWORD) {
            return jsonResponse({ message: 'Authentication successful', token: env.ADMIN_TOKEN });
        }
        return jsonResponse({ error: 'Invalid credentials' }, 401);
    } catch (error) {
        console.error('Error during login:', error.message);
        return jsonResponse({ error: 'Invalid request body' }, 400);
    }
}

// Handle Google Drive Account Settings CRUD operations
async function handleSettings(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    const authError = await checkAdminAuth(request, env);
    if (authError) {
        return authError; // Return 401 if not authorized
    }

    const pathSegments = url.pathname.split('/');
    const action = pathSegments[3]; // e.g., /api/settings/list, /api/settings/add

    if (action === 'add' && method === 'POST') {
        try {
            const settings = await request.json();
            if (!settings.id || !settings.name || !settings.client_id || !settings.client_secret || !settings.refresh_token) {
                return jsonResponse({ error: 'Missing required fields: id, name, client_id, client_secret, refresh_token' }, 400);
            }
            const key = `google_drive_account_${settings.id}`;
            await env.DRIVE_SETTINGS.put(key, JSON.stringify(settings));
            return jsonResponse({ message: `Account '${settings.name}' (ID: ${settings.id}) added successfully.` });
        } catch (error) {
            console.error('Error adding account:', error.message);
            return jsonResponse({ error: 'Invalid request body or internal error' }, 400);
        }
    } else if (action === 'update' && method === 'PUT') {
        const accountId = pathSegments[4]; // /api/settings/update/:id
        if (!accountId) {
            return jsonResponse({ error: 'Missing account ID for update' }, 400);
        }
        try {
            const updates = await request.json();
            const key = `google_drive_account_${accountId}`;
            const existingSettingsString = await env.DRIVE_SETTINGS.get(key);
            if (!existingSettingsString) {
                return jsonResponse({ error: `Account '${accountId}' not found.` }, 404);
            }
            const existingSettings = JSON.parse(existingSettingsString);
            const updatedSettings = { ...existingSettings, ...updates, id: accountId }; // Ensure ID remains consistent
            await env.DRIVE_SETTINGS.put(key, JSON.stringify(updatedSettings));
            return jsonResponse({ message: `Account '${updatedSettings.name}' (ID: ${accountId}) updated successfully.` });
        } catch (error) {
            console.error('Error updating account:', error.message);
            return jsonResponse({ error: 'Invalid request body or internal error' }, 400);
        }
    } else if (action === 'delete' && method === 'DELETE') {
        const accountId = pathSegments[4]; // /api/settings/delete/:id
        if (!accountId) {
            return jsonResponse({ error: 'Missing account ID for delete' }, 400);
        }
        const key = `google_drive_account_${accountId}`;
        await env.DRIVE_SETTINGS.delete(key);
        return jsonResponse({ message: `Account '${accountId}' deleted successfully.` });
    } else if (action === 'list' && method === 'GET') {
        const list = await env.DRIVE_SETTINGS.list();
        const accounts = [];
        for (const key of list.keys) {
            if (key.name.startsWith('google_drive_account_')) {
                const value = await env.DRIVE_SETTINGS.get(key.name);
                // Exclude sensitive refresh_token from list API for security
                const { refresh_token, ...safeSettings } = JSON.parse(value);
                accounts.push(safeSettings);
            }
        }
        return jsonResponse(accounts);
    } else if (action === 'get' && method === 'GET') {
        const accountId = pathSegments[4]; // /api/settings/get/:id
        if (!accountId) {
            return jsonResponse({ error: 'Missing account ID' }, 400);
        }
        const key = `google_drive_account_${accountId}`;
        const accountSettingsString = await env.DRIVE_SETTINGS.get(key);
        if (!accountSettingsString) {
            return jsonResponse({ error: `Account '${accountId}' not found.` }, 404);
        }
        const { refresh_token, ...safeSettings } = JSON.parse(accountSettingsString);
        return jsonResponse(safeSettings); // Return settings without refresh token for security
    } else {
        return jsonResponse({ error: 'Invalid settings API action or method' }, 405);
    }
}

// --- Google Drive Interaction Class ---
// CONSTS object is defined here, before the class uses it.
const CONSTS = {
    folder_mime_type: "application/vnd.google-apps.folder",
    default_file_fields: "id,name,mimeType,size,modifiedTime,thumbnailLink,description,parents",
};

class GoogleDriveService {
    // MODIFIED: Added 'constants' parameter to the constructor
    constructor(accountSettings, constants) {
        this.accountId = accountSettings.id;
        this.client_id = accountSettings.client_id;
        this.client_secret = accountSettings.client_secret;
        this.refresh_token = accountSettings.refresh_token;
        this.accessTokenCache = { token: null, expires: 0 };
        this.accountSettings = accountSettings;
        this.CONSTS = constants; // MODIFIED: Storing CONSTS in the instance
    }

    async getAccessToken() {
        if (this.accessTokenCache.token && this.accessTokenCache.expires > Date.now()) {
            return this.accessTokenCache.token;
        }
        const token = await getAccessToken(this.client_id, this.client_secret, this.refresh_token);
        this.accessTokenCache = { token: token, expires: Date.now() + 3500 * 1000 };
        return token;
    }

    async requestOption(headers = {}, method = 'GET') {
        const accessToken = await this.getAccessToken();
        headers['Authorization'] = `Bearer ${accessToken}`;
        return { method: method, headers: headers };
    }

    async getRootFolderId() {
        return 'root';
    }

    async listItems(parentId = 'root', pageToken = null, pageSize = 100) {
        if (!parentId) {
            parentId = 'root';
        }

        const query = `'${parentId}' in parents and trashed = false`;
        const params = {
            q: query,
            orderBy: "folder,name",
            // MODIFIED: Accessing CONSTS via this.CONSTS
            fields: `nextPageToken, files(${this.CONSTS.default_file_fields})`,
            pageSize: pageSize,
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
        };
        if (pageToken) {
            params.pageToken = pageToken;
        }

        const url = `${GOOGLE_DRIVE_API_BASE}/files?${new URLSearchParams(params).toString()}`;
        const requestOption = await this.requestOption();
        const response = await fetch(url, requestOption);

        if (!response.ok) {
            const errorBody = await response.json();
            console.error(`Google Drive API List Error: ${response.status} - ${JSON.stringify(errorBody)}`);
            throw new Error(`Failed to list items: ${errorBody.error.message || response.status}`);
        }
        return response.json();
    }

    async getFileDetails(fileId) {
        // MODIFIED: Accessing CONSTS via this.CONSTS
        const url = `${GOOGLE_DRIVE_API_BASE}/files/${fileId}?fields=${this.CONSTS.default_file_fields}&supportsAllDrives=true`;
        const requestOption = await this.requestOption();
        const response = await fetch(url, requestOption);

        if (!response.ok) {
            const errorBody = await response.json();
            console.error(`Google Drive API Get File Error: ${response.status} - ${JSON.stringify(errorBody)}`);
            throw new Error(`Failed to get file details: ${errorBody.error.message || response.status}`);
        }
        return response.json();
    }

    async searchFiles(keyword, pageToken = null, pageSize = 100) {
        const sanitizedKeyword = keyword.replace(/['"]/g, '');
        const query = `name contains '${sanitizedKeyword}' and trashed = false`;
        const params = {
            q: query,
            orderBy: "folder,name",
            // MODIFIED: Accessing CONSTS via this.CONSTS
            fields: `nextPageToken, files(${this.CONSTS.default_file_fields})`,
            pageSize: pageSize,
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
        };
        if (pageToken) {
            params.pageToken = pageToken;
        }

        const url = `${GOOGLE_DRIVE_API_BASE}/files?${new URLSearchParams(params).toString()}`;
        const requestOption = await this.requestOption();
        const response = await fetch(url, requestOption);

        if (!response.ok) {
            const errorBody = await response.json();
            console.error(`Google Drive API Search Error: ${response.status} - ${JSON.stringify(errorBody)}`);
            throw new Error(`Failed to search files: ${errorBody.error.message || response.status}`);
        }
        return response.json();
    }

    async getFileStream(fileId, requestHeaders) {
        const driveFileUrl = `${GOOGLE_DRIVE_API_BASE}/files/${fileId}?alt=media`;
        const accessToken = await this.getAccessToken();

        const streamHeaders = new Headers();
        streamHeaders.set('Authorization', `Bearer ${accessToken}`);

        if (requestHeaders.has('Range')) {
            streamHeaders.set('Range', requestHeaders.get('Range'));
        }

        const driveResponse = await fetch(driveFileUrl, {
            headers: streamHeaders,
            redirect: 'follow',
        });

        if (!driveResponse.ok) {
            const errorText = await driveResponse.text();
            console.error(`Google Drive API Stream Error for file ${fileId}: ${driveResponse.status} - ${errorText}`);
            throw new Error(`Failed to retrieve file stream: ${driveResponse.status}`);
        }

        const responseHeaders = new Headers(driveResponse.headers);
        responseHeaders.set('Access-Control-Allow-Origin', '*');

        return new Response(driveResponse.body, {
            status: driveResponse.status,
            headers: responseHeaders,
        });
    }
}


// --- Main Fetch Handler (Router) ---
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const origin = request.headers.get('Origin');

        // Handle CORS preflight requests
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': origin || '*',
                    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                    'Access-Control-Max-Age': '86400',
                },
            });
        }

        // --- API Routing ---
        if (path === '/api/auth/login' && request.method === 'POST') {
            return handleAuthLogin(request, env);
        } else if (path.startsWith('/api/settings')) {
            return handleSettings(request, env);
        } else if (path.startsWith('/api/drive/')) {
            const pathSegments = path.split('/');

            const driveAction = pathSegments[3];
            const accountId = pathSegments[4];

            if (!accountId) {
                return jsonResponse({ error: 'Missing Google Drive Account ID in URL' }, 400);
            }

            const settingsKey = `google_drive_account_${accountId}`;
            const accountSettingsString = await env.DRIVE_SETTINGS.get(settingsKey);

            if (!accountSettingsString) {
                return jsonResponse({ error: `Google Drive Account settings for ID '${accountId}' not found.` }, 404);
            }
            const accountSettings = JSON.parse(accountSettingsString);

            // MODIFIED: Pass CONSTS when creating GoogleDriveService instance
            const driveService = new GoogleDriveService(accountSettings, CONSTS);

            try {
                if (driveAction === 'list' && request.method === 'GET') {
                    const folderId = pathSegments[5] || await driveService.getRootFolderId();
                    const pageToken = url.searchParams.get('pageToken');
                    const pageSize = parseInt(url.searchParams.get('pageSize')) || 100;
                    const result = await driveService.listItems(folderId, pageToken, pageSize);
                    return jsonResponse(result);
                } else if (driveAction === 'file' && request.method === 'GET') {
                    const fileId = pathSegments[5];
                    if (!fileId) return jsonResponse({ error: 'Missing file ID' }, 400);
                    const result = await driveService.getFileDetails(fileId);
                    return jsonResponse(result);
                } else if (driveAction === 'download' && request.method === 'GET') {
                    const fileId = pathSegments[5];
                    if (!fileId) return jsonResponse({ error: 'Missing file ID' }, 400);
                    return driveService.getFileStream(fileId, request.headers);
                } else if (driveAction === 'search' && request.method === 'GET') {
                    const query = url.searchParams.get('q');
                    const pageToken = url.searchParams.get('pageToken');
                    const pageSize = parseInt(url.searchParams.get('pageSize')) || 100;
                    if (!query) return jsonResponse({ error: 'Missing search query (q parameter)' }, 400);
                    const result = await driveService.searchFiles(query, pageToken, pageSize);
                    return jsonResponse(result);
                } else {
                    return jsonResponse({ error: 'Invalid Google Drive API action or method' }, 400);
                }
            } catch (error) {
                console.error('Drive API Handler Error:', error);
                return jsonResponse({ error: `Drive API Error: ${error.message}` }, 500);
            }
        } else {
            // Default response for root or unmatched paths
            return new Response('<h1>Welcome to Axel Drive Backend!</h1><p>Use the /api routes to interact.</p>', {
                headers: { 'Content-Type': 'text/html' },
                status: 200,
            });
        }
    },
};