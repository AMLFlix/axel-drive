// Worker Global Variables
const GOOGLE_AUTH_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

// Helper function to create JSON responses. CORS headers are added globally later.
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json' },
        status: status,
    });
}

// Helper function to get access token from refresh token
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
    
    // The redirect URI must exactly match what's in Google Cloud Console
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
        return new Response(`Authentication Error: ${error.message}`, { status: 500 });
    }
}

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
                const { ...safeSettings } = JSON.parse(value);
                accounts.push(safeSettings);
            }
        }
        return jsonResponse(accounts);
    } else if (action === 'delete' && method === 'DELETE') {
        if (!accountId) return jsonResponse({ error: 'Missing account ID' }, 400);
        await env.DRIVE_SETTINGS.delete(`gdrive_${accountId}`);
        return jsonResponse({ message: `Account '${accountId}' deleted.` });
    }
    return jsonResponse({ error: 'Invalid settings action' }, 404);
}

// ... (Rest of the file remains the same, assuming GoogleDriveService class is there)

class GoogleDriveService {
     // ... Your existing GoogleDriveService class code ...
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
                const apiGroup = path.split('/')[2];
                if (apiGroup === 'auth') {
                     if (path.endsWith('/login')) response = await handleAuthLogin(request, env);
                     else if (path.endsWith('/callback')) response = await handleAuthCallback(request, env);
                     else response = jsonResponse({ error: 'Not Found' }, 404);
                } else if (apiGroup === 'settings') {
                    response = await handleSettings(request, env);
                } else if (apiGroup === 'drive') {
                     // Your drive logic here
                     const pathSegments = path.split('/');
                     const accountId = pathSegments[3];
                     const driveAction = pathSegments[4];
                     if (!accountId) {
                         response = jsonResponse({ error: 'Missing Account ID' }, 400);
                     } else {
                         const settingsKey = `gdrive_${accountId}`;
                         const accountSettingsString = await env.DRIVE_SETTINGS.get(settingsKey);
                         if (!accountSettingsString) {
                            response = jsonResponse({ error: 'Account settings not found.'}, 404);
                         } else {
                            const accountSettings = JSON.parse(accountSettingsString);
                            // Add the global secrets to the settings object before passing to the service
                            const fullSettings = {
                                ...accountSettings,
                                client_id: env.GOOGLE_CLIENT_ID,
                                client_secret: env.GOOGLE_CLIENT_SECRET,
                            };
                            const driveService = new GoogleDriveService(fullSettings, env);
                            // ... rest of your drive logic
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