import { useState, useEffect } from 'react'
import './StatsOverview.css'

interface Stats {
  totalUsers: number
  totalAttempts: number
  successfulVerifications: number
  failedVerifications: number
  whitelistedIPs: number
  blacklistedIPs: number
  recentActivity: Array<{
    id: string
    type: string
    message: string
    timestamp: string
  }>
}

function StatsOverview() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchStats()
  }, [])

  const fetchStats = async () => {
    try {
      const response = await fetch('/api/admin/stats', {
        credentials: 'include',
      })
      if (response.ok) {
        const data = await response.json()
        setStats(data)
      }
    } catch (error) {
      console.error('Failed to fetch stats:', error)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <div className="loading">Chargement des statistiques...</div>
  }

  if (!stats) {
    return <div className="error">Erreur lors du chargement des statistiques</div>
  }

  const successRate = stats.totalAttempts > 0
    ? ((stats.successfulVerifications / stats.totalAttempts) * 100).toFixed(1)
    : 0

  return (
    <div className="stats-overview">
      <h2>Vue d'ensemble</h2>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon">👥</div>
          <div className="stat-content">
            <h3>{stats.totalUsers}</h3>
            <p>Utilisateurs vérifiés</p>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">📊</div>
          <div className="stat-content">
            <h3>{stats.totalAttempts}</h3>
            <p>Tentatives totales</p>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">✅</div>
          <div className="stat-content">
            <h3>{stats.successfulVerifications}</h3>
            <p>Vérifications réussies</p>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">❌</div>
          <div className="stat-content">
            <h3>{stats.failedVerifications}</h3>
            <p>Vérifications échouées</p>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">🎯</div>
          <div className="stat-content">
            <h3>{successRate}%</h3>
            <p>Taux de succès</p>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">🛡️</div>
          <div className="stat-content">
            <h3>{stats.whitelistedIPs + stats.blacklistedIPs}</h3>
            <p>Entrées de liste</p>
          </div>
        </div>
      </div>

      <div className="activity-section">
        <h3>Activité récente</h3>
        <div className="activity-list">
          {stats.recentActivity && stats.recentActivity.length > 0 ? (
            stats.recentActivity.map((activity) => (
              <div key={activity.id} className="activity-item">
                <div className="activity-type">
                  {activity.type === 'success' && <span className="badge badge-success">Succès</span>}
                  {activity.type === 'failure' && <span className="badge badge-danger">Échec</span>}
                  {activity.type === 'whitelist' && <span className="badge badge-info">Whitelist</span>}
                  {activity.type === 'blacklist' && <span className="badge badge-warning">Blacklist</span>}
                </div>
                <div className="activity-message">{activity.message}</div>
                <div className="activity-time">{new Date(activity.timestamp).toLocaleString('fr-FR')}</div>
              </div>
            ))
          ) : (
            <p className="empty-message">Aucune activité récente</p>
          )}
        </div>
      </div>
    </div>
  )
}

export default StatsOverview
