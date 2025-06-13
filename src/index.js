// Worker Global Variables
const GOOGLE_AUTH_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

// --- Helper Functions ---

// Helper function to create JSON responses
// CORS headers will be added by the main handler
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json' },
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
    // NOTE: Use a dedicated admin token secret from your environment variables
    const adminToken = env.ADMIN_PASSWORD || 'your_fallback_secret_token';
    if (token !== adminToken) {
        return jsonResponse({ error: 'Unauthorized: Invalid token' }, 401);
    }
    return null; // Authorized
}


// --- API Handlers ---

// Handle Admin Authentication
async function handleAuthLogin(request, env) {
    try {
        const { username, password } = await request.json();
        const adminUser = env.ADMIN_USERNAME || 'admin';
        const adminPass = env.ADMIN_PASSWORD || 'your_fallback_secret_token';

        if (username === adminUser && password === adminPass) {
            return jsonResponse({ message: 'Authentication successful', token: adminPass });
        }
        return jsonResponse({ error: 'Invalid credentials' }, 401);
    } catch (error) {
        console.error('Error during login:', error.message);
        return jsonResponse({ error: 'Invalid request body' }, 400);
    }
}

// Handle the callback from Google OAuth
async function handleAuthCallback(request, env) {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');

    if (!code) {
        return new Response('Error: Authorization code not found.', { status: 400 });
    }

    const redirectUri = `${url.protocol}//${url.hostname}${url.pathname}`;

    try {
        const tokenResponse = await fetch(GOOGLE_AUTH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code: code,
                client_id: env.GOOGLE_CLIENT_ID,
                client_secret: env.GOOGLE_CLIENT_SECRET,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
            }),
        });

        const tokenData = await tokenResponse.json();

        if (tokenData.error || !tokenData.refresh_token) {
            throw new Error(tokenData.error_description || 'Failed to retrieve refresh token.');
        }

        const profileResponse = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
            headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
        });
        const profileData = await profileResponse.json();

        const html = `
            <!DOCTYPE html><html><head><title>Authentication Success</title></head><body>
            <script>
                const dataToSend = {
                    refreshToken: "${tokenData.refresh_token}",
                    userEmail: "${profileData.email || ''}"
                };
                window.opener.postMessage(dataToSend, 'https://nintendoi.xyz');
                window.close();
            </script>
            <p>Authentication successful. You can close this window.</p>
            </body></html>`;
        return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    } catch (error) {
        console.error('Auth Callback Error:', error);
        return new Response(`Error during authentication: ${error.message}`, { status: 500 });
    }
}

// Handle Google Drive Account Settings CRUD operations
async function handleSettings(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const authError = await checkAdminAuth(request, env);
    if (authError) return authError;

    const pathSegments = url.pathname.split('/');
    const action = pathSegments[3];

    if (action === 'add' && method === 'POST') {
        try {
            const settings = await request.json();
            if (!settings.id || !settings.name || !settings.refresh_token) {
                return jsonResponse({ error: 'Missing required fields: id, name, refresh_token' }, 400);
            }
            const fullSettings = {
                ...settings,
                client_id: env.GOOGLE_CLIENT_ID,
                client_secret: env.GOOGLE_CLIENT_SECRET
            };
            const key = `google_drive_account_${settings.id}`;
            await env.DRIVE_SETTINGS.put(key, JSON.stringify(fullSettings));
            return jsonResponse({ message: `Account '${settings.name}' added successfully.` });
        } catch (error) {
            return jsonResponse({ error: 'Invalid request body or internal error' }, 400);
        }
    } else if (action === 'update' && method === 'PUT') {
        const accountId = pathSegments[4];
        if (!accountId) return jsonResponse({ error: 'Missing account ID' }, 400);
        try {
            const updates = await request.json();
            const key = `google_drive_account_${accountId}`;
            const existing = await env.DRIVE_SETTINGS.get(key);
            if (!existing) return jsonResponse({ error: `Account not found.` }, 404);
            const updated = { ...JSON.parse(existing), ...updates, id: accountId };
            await env.DRIVE_SETTINGS.put(key, JSON.stringify(updated));
            return jsonResponse({ message: `Account updated.` });
        } catch (error) {
            return jsonResponse({ error: 'Invalid request body or internal error' }, 400);
        }
    } else if (action === 'delete' && method === 'DELETE') {
        const accountId = pathSegments[4];
        if (!accountId) return jsonResponse({ error: 'Missing account ID' }, 400);
        await env.DRIVE_SETTINGS.delete(`google_drive_account_${accountId}`);
        return jsonResponse({ message: `Account deleted.` });
    } else if (action === 'list' && method === 'GET') {
        const list = await env.DRIVE_SETTINGS.list({ prefix: 'google_drive_account_' });
        const accounts = [];
        for (const key of list.keys) {
            const value = await env.DRIVE_SETTINGS.get(key.name);
            if (value) {
                 const { client_id, client_secret, refresh_token, ...safeSettings } = JSON.parse(value);
                 accounts.push(safeSettings);
            }
        }
        return jsonResponse(accounts);
    } else if (action === 'get' && method === 'GET') {
        const accountId = pathSegments[4];
        if (!accountId) return jsonResponse({ error: 'Missing account ID' }, 400);
        const value = await env.DRIVE_SETTINGS.get(`google_drive_account_${accountId}`);
        if (!value) return jsonResponse({ error: `Account not found.` }, 404);
        const { client_id, client_secret, refresh_token, ...safeSettings } = JSON.parse(value);
        return jsonResponse(safeSettings);
    } else {
        return jsonResponse({ error: 'Invalid settings API action or method' }, 405);
    }
}

// --- Google Drive Interaction Class ---
const CONSTS = {
    folder_mime_type: "application/vnd.google-apps.folder",
    default_file_fields: "id,name,mimeType,size,modifiedTime,thumbnailLink,description,parents",
};

class GoogleDriveService {
    constructor(accountSettings) {
        this.client_id = accountSettings.client_id;
        this.client_secret = accountSettings.client_secret;
        this.refresh_token = accountSettings.refresh_token;
        this.accessTokenCache = { token: null, expires: 0 };
    }
    async getAccessToken() {
        if (this.accessTokenCache.token && this.accessTokenCache.expires > Date.now()) {
            return this.accessTokenCache.token;
        }
        const token = await getAccessToken(this.client_id, this.client_secret, this.refresh_token);
        this.accessTokenCache = { token, expires: Date.now() + 3500 * 1000 };
        return token;
    }
    async requestOption(headers = {}, method = 'GET') {
        const accessToken = await this.getAccessToken();
        headers['Authorization'] = `Bearer ${accessToken}`;
        return { method, headers };
    }
    async listItems(parentId = 'root', pageToken = null, pageSize = 100) {
        const query = `'${parentId}' in parents and trashed = false`;
        const params = { q: query, orderBy: "folder,name", fields: `nextPageToken, files(${CONSTS.default_file_fields})`, pageSize, includeItemsFromAllDrives: true, supportsAllDrives: true };
        if (pageToken) params.pageToken = pageToken;
        const url = `${GOOGLE_DRIVE_API_BASE}/files?${new URLSearchParams(params)}`;
        const response = await fetch(url, await this.requestOption());
        if (!response.ok) throw new Error(`Failed to list items: ${await response.text()}`);
        return response.json();
    }
    async getFileDetails(fileId) {
        const url = `${GOOGLE_DRIVE_API_BASE}/files/${fileId}?fields=${CONSTS.default_file_fields}&supportsAllDrives=true`;
        const response = await fetch(url, await this.requestOption());
        if (!response.ok) throw new Error(`Failed to get file details: ${await response.text()}`);
        return response.json();
    }
    async searchFiles(keyword, pageToken = null, pageSize = 100) {
        const query = `name contains '${keyword.replace(/['"]/g, '')}' and trashed = false`;
        const params = { q: query, orderBy: "folder,name", fields: `nextPageToken, files(${CONSTS.default_file_fields})`, pageSize, includeItemsFromAllDrives: true, supportsAllDrives: true };
        if (pageToken) params.pageToken = pageToken;
        const url = `${GOOGLE_DRIVE_API_BASE}/files?${new URLSearchParams(params)}`;
        const response = await fetch(url, await this.requestOption());
        if (!response.ok) throw new Error(`Failed to search files: ${await response.text()}`);
        return response.json();
    }
    async getFileStream(fileId, requestHeaders) {
        const url = `${GOOGLE_DRIVE_API_BASE}/files/${fileId}?alt=media`;
        const headers = new Headers(requestHeaders);
        headers.set('Authorization', `Bearer ${await this.getAccessToken()}`);
        const driveResponse = await fetch(url, { headers, redirect: 'follow' });
        if (!driveResponse.ok) throw new Error(`Failed to stream file: ${await driveResponse.text()}`);
        const responseHeaders = new Headers(driveResponse.headers);
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        return new Response(driveResponse.body, { status: driveResponse.status, headers: responseHeaders });
    }
}

// --- Main Fetch Handler (Router) ---
export default {
    async fetch(request, env, ctx) {
        const corsHeaders = {
            'Access-Control-Allow-Origin': 'https://nintendoi.xyz',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        let response;
        try {
            const url = new URL(request.url);
            const path = url.pathname;
            if (path === '/api/auth/login') {
                response = await handleAuthLogin(request, env);
            } else if (path === '/api/auth/callback') {
                response = await handleAuthCallback(request, env);
            } else if (path.startsWith('/api/settings')) {
                response = await handleSettings(request, env);
            } else if (path.startsWith('/api/drive/')) {
                const pathSegments = path.split('/');
                const driveAction = pathSegments[3];
                const accountId = pathSegments[4];
                if (!accountId) {
                    response = jsonResponse({ error: 'Missing Account ID' }, 400);
                } else {
                    const settings = await env.DRIVE_SETTINGS.get(`google_drive_account_${accountId}`);
                    if (!settings) {
                        response = jsonResponse({ error: `Account settings not found.` }, 404);
                    } else {
                        const driveService = new GoogleDriveService(JSON.parse(settings));
                        const fileId = pathSegments[5];
                        const pageToken = url.searchParams.get('pageToken');
                        switch (driveAction) {
                            case 'list':
                                response = jsonResponse(await driveService.listItems(fileId || 'root', pageToken));
                                break;
                            case 'get':
                                if (!fileId) response = jsonResponse({ error: 'Missing file ID' }, 400);
                                else response = jsonResponse(await driveService.getFileDetails(fileId));
                                break;
                            case 'download':
                                if (!fileId) return jsonResponse({ error: 'Missing file ID' }, 400);
                                return driveService.getFileStream(fileId, request.headers); // Exits early for stream
                            case 'search':
                                const query = url.searchParams.get('q');
                                if (!query) response = jsonResponse({ error: 'Missing search query' }, 400);
                                else response = jsonResponse(await driveService.searchFiles(query, pageToken));
                                break;
                            default:
                                response = jsonResponse({ error: 'Invalid Drive API action' }, 400);
                        }
                    }
                }
            } else {
                response = new Response('Welcome to Axel Drive Backend!', { headers: { 'Content-Type': 'text/html' }});
            }
        } catch (error) {
            console.error('Unhandled error:', error);
            response = jsonResponse({ error: 'Internal Server Error', details: error.message }, 500);
        }

        const finalResponse = new Response(response.body, response);
        for (const [key, value] of Object.entries(corsHeaders)) {
            finalResponse.headers.set(key, value);
        }
        return finalResponse;
    },
};