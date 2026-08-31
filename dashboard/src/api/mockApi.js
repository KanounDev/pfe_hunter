// API module - switches between real and mock API based on environment
// Set VITE_USE_MOCK_API=true in .env to use mock data for development

const USE_MOCK = import.meta.env.VITE_USE_MOCK_API === 'true';

// Real API
import * as realApi from './api.js';

// Mock API
import * as mockApi from './mockApiData.js';

// Export the appropriate API based on environment
const api = USE_MOCK ? mockApi : realApi;

export const getPostings = api.getPostings;
export const getPostingById = api.getPostingById;
export const getStats = api.getStats;
export const getRuns = api.getRuns;
export const getScoreDistribution = api.getScoreDistribution;
