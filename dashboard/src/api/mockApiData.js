// Mock API data for development without backend

const mockPostings = [
  {
    job_id: 'job_001',
    job_url: 'https://linkedin.com/jobs/view/1234567890',
    title: 'Software Engineer Intern',
    company: 'TechCorp',
    location: 'Paris, France',
    description: 'We are looking for a motivated software engineering intern to join our team. You will work on backend services using Node.js and Python, collaborate with senior engineers, and participate in code reviews.',
    fit_score: 85,
    fit_reasoning: 'Strong match for backend skills with Node.js and Python experience. Relevant internship experience in similar role.',
    created_at: '2026-08-26T10:00:00Z',
    scored_at: '2026-08-26T10:05:00Z',
    notified_at: '2026-08-26T10:10:00Z',
  },
  {
    job_id: 'job_002',
    job_url: 'https://linkedin.com/jobs/view/1234567891',
    title: 'Backend Developer Intern',
    company: 'StartupXYZ',
    location: 'Lyon, France',
    description: 'Join our fast-growing startup as a backend developer intern. You will build APIs, work with databases, and learn about microservices architecture.',
    fit_score: 78,
    fit_reasoning: 'Good alignment with backend development interests. Microservices exposure would be valuable learning experience.',
    created_at: '2026-08-26T09:00:00Z',
    scored_at: '2026-08-26T09:05:00Z',
    notified_at: '2026-08-26T09:10:00Z',
  },
  {
    job_id: 'job_003',
    job_url: 'https://linkedin.com/jobs/view/1234567892',
    title: 'Data Engineer Intern',
    company: 'DataCorp',
    location: 'Remote',
    description: 'We are seeking a data engineering intern to help build data pipelines and analytics dashboards. Experience with Python and SQL required.',
    fit_score: 72,
    fit_reasoning: 'Python skills transfer well. SQL experience from academic projects is relevant. Remote work is flexible.',
    created_at: '2026-08-26T08:00:00Z',
    scored_at: '2026-08-26T08:05:00Z',
    notified_at: null,
  },
  {
    job_id: 'job_004',
    job_url: 'https://linkedin.com/jobs/view/1234567893',
    title: 'Full Stack Developer',
    company: 'WebAgency',
    location: 'Bordeaux, France',
    description: 'Full stack developer position for React and Node.js. You will build web applications from scratch and deploy to cloud platforms.',
    fit_score: 65,
    fit_reasoning: 'Good tech stack match but position is full-time, not internship. May still be worth considering.',
    created_at: '2026-08-25T14:00:00Z',
    scored_at: '2026-08-25T14:05:00Z',
    notified_at: null,
  },
  {
    job_id: 'job_005',
    job_url: 'https://linkedin.com/jobs/view/1234567894',
    title: 'AI Research Intern',
    company: 'AILabs',
    location: 'Paris, France',
    description: 'Research internship in machine learning and NLP. You will work on cutting-edge AI projects and publish papers.',
    fit_score: 90,
    fit_reasoning: 'Perfect match for AI track interest. Research experience highly valuable for future career. Location is ideal.',
    created_at: '2026-08-25T10:00:00Z',
    scored_at: '2026-08-25T10:05:00Z',
    notified_at: '2026-08-25T10:10:00Z',
  },
  {
    job_id: 'job_006',
    job_url: 'https://linkedin.com/jobs/view/1234567895',
    title: 'DevOps Engineer Intern',
    company: 'CloudTech',
    location: 'Toulouse, France',
    description: 'DevOps internship focusing on CI/CD pipelines, Kubernetes, and cloud infrastructure on AWS.',
    fit_score: 45,
    fit_reasoning: 'Limited DevOps experience in background. May require significant learning curve for Kubernetes and AWS.',
    created_at: '2026-08-24T16:00:00Z',
    scored_at: '2026-08-24T16:05:00Z',
    notified_at: null,
  },
  {
    job_id: 'job_007',
    job_url: 'https://linkedin.com/jobs/view/1234567896',
    title: 'Frontend Developer Intern',
    company: 'UICorp',
    location: 'Nantes, France',
    description: 'Frontend development with React and TypeScript. Build beautiful user interfaces and improve UX.',
    fit_score: 30,
    fit_reasoning: 'Frontend focus does not align with backend/AI career direction. TypeScript experience limited.',
    created_at: '2026-08-24T12:00:00Z',
    scored_at: '2026-08-24T12:05:00Z',
    notified_at: null,
  },
  {
    job_id: 'job_008',
    job_url: 'https://linkedin.com/jobs/view/1234567897',
    title: 'Machine Learning Intern',
    company: 'MLStartup',
    location: 'Remote',
    description: 'Work on production ML models, feature engineering, and model deployment using Python and TensorFlow.',
    fit_score: 82,
    fit_reasoning: 'Strong ML alignment with academic background. TensorFlow is a good addition to skill set. Remote flexibility.',
    created_at: '2026-08-23T09:00:00Z',
    scored_at: '2026-08-23T09:05:00Z',
    notified_at: '2026-08-23T09:10:00Z',
  },
];

const mockRuns = [
  { timestamp: '2026-08-26T11:19:27Z', status: 'success', inserted: 6, scored: 6, elapsed_seconds: 56.7 },
  { timestamp: '2026-08-26T06:00:00Z', status: 'success', inserted: 3, scored: 3, elapsed_seconds: 42.3 },
  { timestamp: '2026-08-26T00:00:00Z', status: 'success', inserted: 0, scored: 0, elapsed_seconds: 15.2 },
  { timestamp: '2026-08-25T18:00:00Z', status: 'success', inserted: 4, scored: 4, elapsed_seconds: 38.9 },
  { timestamp: '2026-08-25T12:00:00Z', status: 'failed', step: 'scraper', error: 'LinkedIn rate limit exceeded', elapsed_seconds: 12.1 },
  { timestamp: '2026-08-25T06:00:00Z', status: 'success', inserted: 5, scored: 5, elapsed_seconds: 45.6 },
];

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function getPostings({ minScore, maxScore, company, location, notified } = {}) {
  await delay(200);
  let filtered = [...mockPostings];

  if (minScore !== undefined) filtered = filtered.filter(p => p.fit_score >= minScore);
  if (maxScore !== undefined) filtered = filtered.filter(p => p.fit_score <= maxScore);
  if (company) filtered = filtered.filter(p => p.company?.toLowerCase().includes(company.toLowerCase()));
  if (location) filtered = filtered.filter(p => p.location?.toLowerCase().includes(location.toLowerCase()));
  if (notified === 'notified') filtered = filtered.filter(p => p.notified_at !== null);
  if (notified === 'not-notified') filtered = filtered.filter(p => p.notified_at === null);

  return filtered;
}

export async function getPostingById(id) {
  await delay(100);
  return mockPostings.find(p => p.job_id === id) || null;
}

export async function getStats() {
  await delay(100);
  const scores = mockPostings.map(p => p.fit_score).filter(s => s !== null);
  return {
    total: mockPostings.length,
    averageScore: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
    highFit: mockPostings.filter(p => p.fit_score >= 70).length,
    notified: mockPostings.filter(p => p.notified_at !== null).length,
    unscored: mockPostings.filter(p => p.fit_score === null).length,
  };
}

export async function getRuns(limit = 10) {
  await delay(100);
  return mockRuns.slice(0, limit);
}

export async function getScoreDistribution() {
  await delay(100);
  const distribution = { '0-20': 0, '21-40': 0, '41-60': 0, '61-80': 0, '81-100': 0 };
  mockPostings.forEach(p => {
    if (p.fit_score === null) return;
    if (p.fit_score <= 20) distribution['0-20']++;
    else if (p.fit_score <= 40) distribution['21-40']++;
    else if (p.fit_score <= 60) distribution['41-60']++;
    else if (p.fit_score <= 80) distribution['61-80']++;
    else distribution['81-100']++;
  });
  return distribution;
}
