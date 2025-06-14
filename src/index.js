// --- Worker Globals & Helpers ---
const GOOGLE_AUTH_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const CONSTS = {
    folder_mime_type: "application/vnd.google-apps.folder",
    default_file_fields: "id,name,mimeType,size,modifiedTime,parents",
};

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json' },
        status,
    });
}

async function getAccessToken(env, refresh_token) {
    const response = await fetch(GOOGLE_AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            refresh_token: refresh_token,
            grant_type: 'refresh_token',
        }),
    });
    if (!response.ok) {
        const errorText = await response.text();
        console.error('Failed to get access token:', errorText);
        throw new Error(`Failed to get access token: ${response.status}`);
    }
    const data = await response.json();
    return data.access_token;
}

// --- API Handlers ---

async function handleAuthLogin(request, env) {
    const { username, password } = await request.json();
    if (username === env.ADMIN_USERNAME && password === env.ADMIN_PASSWORD) {
        return jsonResponse({ token: env.ADMIN_TOKEN });
    }
    return jsonResponse({ error: 'Invalid credentials' }, 401);
}

async function handleAuthCallback(request, env) {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    if (!code) return new Response('Error: Authorization code not found.', { status: 400 });
    
    const redirectUri = url.origin + url.pathname;
    try {
        const tokenResponse = await fetch(GOOGLE_AUTH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code,
                client_id: env.GOOGLE_CLIENT_ID,
                client_secret: env.GOOGLE_CLIENT_SECRET,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
            }),
        });
        const tokenData = await tokenResponse.json();
        if (tokenData.error || !tokenData.refresh_token) {
            throw new Error(tokenData.error_description || 'Failed to get refresh token.');
        }
        const profileResponse = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
            headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
        });
        const profileData = await profileResponse.json();
        const html = `
            <!DOCTYPE html><html><head><title>Auth Success</title></head><body>
            <script>
                window.opener.postMessage({
                    refreshToken: "${tokenData.refresh_token}",
                    userEmail: "${profileData.email || ''}"
                }, '${url.origin}');
                window.close();
            </script>
            <p>Success! You can close this window.</p>
            </body></html>`;
        return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    } catch (error) {
        console.error("Auth Callback Error:", error);
        return new Response(`Authentication Error: ${error.message}`, { status: 500 });
    }
}

// ** CORRECTED `handleSettings` function **
async function handleSettings(request, env) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== env.ADMIN_TOKEN) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const url = new URL(request.url);
    const method = request.method;
    const pathSegments = url.pathname.split('/');
    const action = pathSegments[3];
    const accountId = pathSegments[4];

    if (action === 'add' && method === 'POST') {
        const { id, name, refresh_token } = await request.json();
        if (!id || !name || !refresh_token) {
            return jsonResponse({ error: 'Missing required fields: id, name, refresh_token' }, 400);
        }
        const fullSettings = { id, name, refresh_token };
        await env.DRIVE_SETTINGS.put(`gdrive_${id}`, JSON.stringify(fullSettings));
        return jsonResponse({ message: `Account '${name}' added.` });
    } else if (action === 'list' && method === 'GET') {
        const list = await env.DRIVE_SETTINGS.list({ prefix: 'gdrive_' });
        const accounts = [];
        for (const key of list.keys) {
            const value = await env.DRIVE_SETTINGS.get(key.name);
            if (value) {
                const { ...accountData } = JSON.parse(value);
                accounts.push({id: accountData.id, name: accountData.name});
            }
        }
        return jsonResponse(accounts);
    } else if (action === 'delete' && method === 'DELETE') {
        if (!accountId) return jsonResponse({ error: 'Missing account ID' }, 400);
        await env.DRIVE_SETTINGS.delete(`gdrive_${accountId}`);
        return jsonResponse({ message: `Account '${accountId}' deleted.` });
    }
    return jsonResponse({ error: 'Invalid settings API action or method' }, 404);
}

class GoogleDriveService {
    constructor(accountSettings, env) {
        this.env = env;
        this.refresh_token = accountSettings.refresh_token;
        this.accessTokenCache = { token: null, expires: 0 };
    }
    async getAccessToken() {
        if (this.accessTokenCache.token && this.accessTokenCache.expires > Date.now()) {
            return this.accessTokenCache.token;
        }
        const token = await getAccessToken(this.env, this.refresh_token);
        this.accessTokenCache = { token, expires: Date.now() + 3500 * 1000 };
        return token;
    }
    async requestOption(headers = {}) {
        const accessToken = await this.getAccessToken();
        headers['Authorization'] = `Bearer ${accessToken}`;
        return { headers };
    }
    async listItems(parentId = 'root', pageToken = null) {
        const query = `'${parentId}' in parents and trashed = false`;
        const params = { q: query, orderBy: "folder,name", fields: `nextPageToken, files(${CONSTS.default_file_fields})`, pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true };
        if (pageToken) params.pageToken = pageToken;
        const url = `${GOOGLE_DRIVE_API_BASE}/files?${new URLSearchParams(params)}`;
        const response = await fetch(url, await this.requestOption());
        if (!response.ok) throw new Error(`API Error while listing items: ${await response.text()}`);
        return response.json();
    }
    async searchFiles(keyword, pageToken = null) {
        const query = `name contains '${keyword.replace(/['"]/g, '')}' and trashed = false`;
        const params = { q: query, fields: `nextPageToken, files(${CONSTS.default_file_fields})`, pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true };
        if (pageToken) params.pageToken = pageToken;
        const url = `${GOOGLE_DRIVE_API_BASE}/files?${new URLSearchParams(params)}`;
        const response = await fetch(url, await this.requestOption());
        if (!response.ok) throw new Error(`API Error while searching: ${await response.text()}`);
        return response.json();
    }
    async getFileStream(fileId, request) {
        const url = `${GOOGLE_DRIVE_API_BASE}/files/${fileId}?alt=media&supportsAllDrives=true`;
        const headers = new Headers(request.headers);
        headers.set('Authorization', `Bearer ${await this.getAccessToken()}`);
        const driveResponse = await fetch(url, { headers, redirect: 'follow' });
        if (!driveResponse.ok) throw new Error(`Stream Error: ${await driveResponse.text()}`);
        const responseHeaders = new Headers(driveResponse.headers);
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        return new Response(driveResponse.body, { status: driveResponse.status, statusText: driveResponse.statusText, headers: responseHeaders });
    }
}

// --- Main Fetch Handler (Router) ---
export default {
    async fetch(request, env, ctx) {
        const corsHeaders = {
            'Access-Control-Allow-Origin': new URL(request.url).origin,
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Vary': 'Origin',
        };
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }
        let response;
        try {
            const url = new URL(request.url);
            const path = url.pathname;
            
            if (path.startsWith('/api/')) {
                const pathSegments = path.split('/');
                const apiGroup = pathSegments[2];
                const action = pathSegments[3];
                
                if (apiGroup === 'auth') {
                    if (action === 'login') response = await handleAuthLogin(request, env);
                    else if (action === 'callback') response = await handleAuthCallback(request, env);
                    else response = jsonResponse({ error: 'Not Found' }, 404);
                } else if (apiGroup === 'settings') {
                    response = await handleSettings(request, env);
                } else if (apiGroup === 'drive') {
                    const accountId = pathSegments[3];
                    const driveAction = pathSegments[4];
                    if (!accountId) {
                        response = jsonResponse({ error: 'Missing Account ID' }, 400);
                    } else {
                        const settingsString = await env.DRIVE_SETTINGS.get(`gdrive_${accountId}`);
                        if (!settingsString) {
                            response = jsonResponse({ error: `Account settings not found.`}, 404);
                        } else {
                            const accountSettings = JSON.parse(settingsString);
                            const driveService = new GoogleDriveService(accountSettings, env);
                            const resourceId = pathSegments[5];
                            const pageToken = url.searchParams.get('pageToken');

                            switch (driveAction) {
                                case 'list':
                                    response = jsonResponse(await driveService.listItems(resourceId || 'root', pageToken));
                                    break;
                                case 'download':
                                    if (!resourceId) return jsonResponse({ error: 'Missing file ID' }, 400);
                                    return driveService.getFileStream(resourceId, request); // Exits early for stream
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
                    response = jsonResponse({ error: 'Not Found' }, 404);
                }
            } else {
                response = new Response('Axel Drive Backend is running.', { headers: { 'Content-Type': 'text/plain' }});
            }
        } catch (error) {
            console.error('Unhandled error:', error);
            response = jsonResponse({ error: 'Internal Server Error', details: error.message }, 500);
        }
        const finalResponse = new Response(response.body, response);
        Object.entries(corsHeaders).forEach(([key, value]) => finalResponse.headers.set(key, value));
        return finalResponse;
    },
};