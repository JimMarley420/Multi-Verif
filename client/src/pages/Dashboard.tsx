import { useState } from 'react'
import './Dashboard.css'
import UserManagement from '../components/UserManagement'
import WhitelistManager from '../components/WhitelistManager'
import BlacklistManager from '../components/BlacklistManager'
import StatsOverview from '../components/StatsOverview'
import VerificationLogs from '../components/VerificationLogs'

interface DashboardProps {
  user: {
    discordId: string
    discordUsername: string
    discordAvatar?: string
  }
  onLogout: () => void
}

type TabType = 'overview' | 'users' | 'whitelist' | 'blacklist' | 'logs'

function Dashboard({ user, onLogout }: DashboardProps) {
  const [activeTab, setActiveTab] = useState<TabType>('overview')

  const tabs = [
    { id: 'overview' as TabType, label: 'Vue d\'ensemble', icon: '📊' },
    { id: 'users' as TabType, label: 'Utilisateurs', icon: '👥' },
    { id: 'whitelist' as TabType, label: 'Whitelist', icon: '✅' },
    { id: 'blacklist' as TabType, label: 'Blacklist', icon: '🚫' },
    { id: 'logs' as TabType, label: 'Logs', icon: '📝' },
  ]

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="header-content">
          <div className="brand">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 2L2 7v10c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-10-5z"
                fill="var(--accent-primary)"
              />
              <path
                d="M10 17l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"
                fill="white"
              />
            </svg>
            <div>
              <h1>VeeriBot Dashboard</h1>
              <p>Panneau d'administration</p>
            </div>
          </div>
          <div className="user-menu">
            <div className="user-info">
              {user.discordAvatar ? (
                <img
                  src={`https://cdn.discordapp.com/avatars/${user.discordId}/${user.discordAvatar}.png`}
                  alt={user.discordUsername}
                  className="user-avatar"
                />
              ) : (
                <div className="user-avatar-placeholder">
                  {user.discordUsername.charAt(0).toUpperCase()}
                </div>
              )}
              <span>{user.discordUsername}</span>
            </div>
            <button onClick={onLogout} className="btn btn-secondary">
              Déconnexion
            </button>
          </div>
        </div>
      </header>

      <div className="dashboard-container">
        <nav className="dashboard-sidebar">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`nav-item ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="nav-icon">{tab.icon}</span>
              <span className="nav-label">{tab.label}</span>
            </button>
          ))}
        </nav>

        <main className="dashboard-content">
          {activeTab === 'overview' && <StatsOverview />}
          {activeTab === 'users' && <UserManagement />}
          {activeTab === 'whitelist' && <WhitelistManager />}
          {activeTab === 'blacklist' && <BlacklistManager />}
          {activeTab === 'logs' && <VerificationLogs />}
        </main>
      </div>
    </div>
  )
}

export default Dashboard
