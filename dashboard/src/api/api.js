// Real API layer - connects to Express backend (Postgres only)

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';
const API_TOKEN = import.meta.env.VITE_API_TOKEN;

// Maps HTTP status codes to actionable, human-friendly guidance.
function describeHttpError(status, serverMessage) {
  switch (status) {
    case 401:
      return 'Unauthorized — the API token is missing or invalid. Check that VITE_API_TOKEN in dashboard/.env matches API_TOKEN in the backend .env, then restart the dev server.';
    case 403:
      return 'Forbidden — your token is valid but this action is not allowed.';
    case 404:
      return serverMessage || 'Not found.';
    case 429:
      return 'Rate limit exceeded — too many requests. Wait a few minutes and try again.';
    case 503:
      return serverMessage || 'Service temporarily unavailable.';
    default:
      return serverMessage || `HTTP ${status}`;
  }
}

// Helper for fetch with error handling
async function apiFetch(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;

  try {
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
        ...options.headers,
      },
      ...options,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(describeHttpError(response.status, error.error));
    }

    return response.json();
  } catch (err) {
    // Network errors, CORS, etc.
    if (err.name === 'TypeError' && err.message === 'Failed to fetch') {
      throw new Error('Cannot connect to API server. Make sure the backend is running on port 3001.');
    }
    throw err;
  }
}

// Get all postings with optional filters
export async function getPostings({ minScore, maxScore, company, location, notified, sort, order } = {}) {
  const params = new URLSearchParams();

  if (minScore !== undefined) params.append('minScore', minScore);
  if (maxScore !== undefined) params.append('maxScore', maxScore);
  if (company) params.append('company', company);
  if (location) params.append('location', location);
  if (notified) params.append('notified', notified);
  if (sort) params.append('sort', sort);
  if (order) params.append('order', order);

  const queryString = params.toString();
  const endpoint = queryString ? `/postings?${queryString}` : '/postings';

  return apiFetch(endpoint);
}

// Get single posting by ID
export async function getPostingById(id) {
  return apiFetch(`/postings/${id}`);
}

// Get aggregated statistics
export async function getStats() {
  return apiFetch('/stats');
}

// Get recent run history
export async function getRuns(limit = 10) {
  return apiFetch(`/runs?limit=${limit}`);
}

// Get score distribution for charts
export async function getScoreDistribution() {
  return apiFetch('/distribution');
}

// Get unique companies for filter dropdown
export async function getCompanies() {
  return apiFetch('/companies');
}

// Get unique locations for filter dropdown
export async function getLocations() {
  return apiFetch('/locations');
}

// Health check
export async function checkHealth() {
  return apiFetch('/health');
}

// Get all settings
export async function getSettings() {
  return apiFetch('/settings');
}

// Get single setting
export async function getSetting(key) {
  return apiFetch(`/settings/${key}`);
}

// Update single setting
export async function updateSetting(key, value) {
  return apiFetch(`/settings/${key}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
}

// Update multiple settings
export async function updateSettings(settings) {
  return apiFetch('/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  });
}

// Reset settings to defaults
export async function resetSettings() {
  return apiFetch('/settings/reset', {
    method: 'POST',
  });
}

// CV Management
export async function getCV() {
  return apiFetch('/cv');
}

export async function uploadCV(file) {
  const formData = new FormData();
  formData.append('cv', file);

  const response = await fetch(`${API_BASE}/cv/upload`, {
    method: 'POST',
    headers: {
      ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(describeHttpError(response.status, error.error));
  }

  return response.json();
}

export async function deleteCV() {
  return apiFetch('/cv', {
    method: 'DELETE',
  });
}

export async function downloadCV() {
  const response = await fetch(`${API_BASE}/cv/download`, {
    headers: {
      ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(describeHttpError(response.status, error.error));
  }
  return response.blob();
}

// Pipeline Management
export async function triggerPipeline() {
  return apiFetch('/pipeline/trigger', {
    method: 'POST',
  });
}

export async function getPipelineStatus() {
  return apiFetch('/pipeline/status');
}

export async function getPipelineRuns(limit = 20) {
  return apiFetch(`/pipeline/runs?limit=${limit}`);
}
