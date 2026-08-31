// API module - connects directly to real backend (no mock data)
// All data comes from Postgres database

import * as api from './api.js';

export const getPostings = api.getPostings;
export const getPostingById = api.getPostingById;
export const getStats = api.getStats;
export const getRuns = api.getRuns;
export const getScoreDistribution = api.getScoreDistribution;
export const checkHealth = api.checkHealth;
