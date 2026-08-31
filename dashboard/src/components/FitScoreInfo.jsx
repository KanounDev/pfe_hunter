import { useState } from 'react'
import '../styles/FitScoreInfo.css'

function FitScoreInfo() {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <>
      <button
        className="fit-score-info-trigger"
        onClick={() => setIsOpen(true)}
        aria-label="Learn about fit score"
      >
        ℹ️
      </button>

      {isOpen && (
        <div className="fit-score-modal-overlay" onClick={() => setIsOpen(false)}>
          <div className="fit-score-modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="modal-close"
              onClick={() => setIsOpen(false)}
              aria-label="Close"
            >
              ×
            </button>

            <div className="modal-content">
              <h2>🎯 Understanding Fit Score</h2>

              <div className="info-section">
                <h3>What is the Fit Score?</h3>
                <p>
                  The fit score is a <strong>0-100 rating</strong> calculated by Google's Gemini AI
                  that measures how well a job posting matches your uploaded CV. Higher scores indicate
                  better alignment with your skills and experience.
                </p>
              </div>

              <div className="info-section">
                <h3>How is it Calculated?</h3>
                <p>Gemini AI analyzes multiple dimensions when calculating your fit score:</p>

                <div className="criteria-grid">
                  <div className="criteria-item">
                    <span className="criteria-icon">💻</span>
                    <div>
                      <h4>Skills Match</h4>
                      <p>Compares job requirements with your technical skills, frameworks, and tools</p>
                    </div>
                  </div>

                  <div className="criteria-item">
                    <span className="criteria-icon">📊</span>
                    <div>
                      <h4>Experience Level</h4>
                      <p>Evaluates if the role's seniority aligns with your experience</p>
                    </div>
                  </div>

                  <div className="criteria-item">
                    <span className="criteria-icon">🎓</span>
                    <div>
                      <h4>Education Alignment</h4>
                      <p>Matches educational requirements with your background</p>
                    </div>
                  </div>

                  <div className="criteria-item">
                    <span className="criteria-icon">📍</span>
                    <div>
                      <h4>Location Fit</h4>
                      <p>Considers location preferences and remote work options</p>
                    </div>
                  </div>

                  <div className="criteria-item">
                    <span className="criteria-icon">🔧</span>
                    <div>
                      <h4>Technology Stack</h4>
                      <p>Matches programming languages and technologies you know</p>
                    </div>
                  </div>

                  <div className="criteria-item">
                    <span className="criteria-icon">💼</span>
                    <div>
                      <h4>Role Type</h4>
                      <p>Evaluates job type (internship, full-time, contract) alignment</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="info-section">
                <h3>Score Interpretation</h3>
                <div className="score-ranges">
                  <div className="score-range high">
                    <span className="range-value">80-100</span>
                    <span className="range-label">Excellent Match</span>
                    <span className="range-desc">Highly relevant, strongly recommended to apply</span>
                  </div>
                  <div className="score-range good">
                    <span className="range-value">60-79</span>
                    <span className="range-label">Good Match</span>
                    <span className="range-desc">Solid alignment, worth considering</span>
                  </div>
                  <div className="score-range moderate">
                    <span className="range-value">40-59</span>
                    <span className="range-label">Moderate Match</span>
                    <span className="range-desc">Some gaps, review requirements carefully</span>
                  </div>
                  <div className="score-range low">
                    <span className="range-value">0-39</span>
                    <span className="range-label">Low Match</span>
                    <span className="range-desc">Significant gaps, may not be suitable</span>
                  </div>
                </div>
              </div>

              <div className="info-section rate-limit-box">
                <h3>⚡ API Rate Limits</h3>
                <div className="rate-limit-content">
                  <div className="rate-limit-item">
                    <span className="rate-label">Free Tier:</span>
                    <span className="rate-value">100 requests per day</span>
                  </div>
                  <div className="rate-limit-item">
                    <span className="rate-label">Paid Tier:</span>
                    <span className="rate-value">Up to 1,000 requests per day (RPD)</span>
                  </div>
                </div>
                <p className="rate-limit-note">
                  Each job posting requires one Gemini API call for scoring. The system automatically
                  scores new postings during each pipeline run.
                </p>
              </div>

              <div className="info-section tips-box">
                <h3>💡 Tips to Improve Scores</h3>
                <ul>
                  <li>Upload a detailed, up-to-date CV with clear skills sections</li>
                  <li>Include specific technologies, frameworks, and tools you've used</li>
                  <li>Quantify achievements (e.g., "Improved performance by 40%")</li>
                  <li>List relevant projects with technology stacks</li>
                  <li>Keep your CV formatted and well-structured</li>
                </ul>
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn-primary" onClick={() => setIsOpen(false)}>
                Got it!
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default FitScoreInfo
