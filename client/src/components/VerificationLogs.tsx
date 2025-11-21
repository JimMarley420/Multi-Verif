import { useState, useEffect } from 'react'
import './VerificationLogs.css'

interface LogEntry {
  id: string
  discordId: string
  ipAddress: string
  success: boolean
  reason?: string
  createdAt: string
}

function VerificationLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    fetchLogs()
  }, [])

  const fetchLogs = async () => {
    try {
      const response = await fetch('/api/admin/logs', { credentials: 'include' })
      if (response.ok) {
        const data = await response.json()
        setLogs(data.logs)
      }
    } catch (error) {
      console.error('Failed to fetch logs:', error)
    } finally {
      setLoading(false)
    }
  }

  const filteredLogs = logs.filter((log) => {
    if (filter === 'success') return log.success
    if (filter === 'failed') return !log.success
    return true
  })

  if (loading) return <div className="loading">Chargement des logs...</div>

  return (
    <div className="verification-logs">
      <div className="section-header">
        <h2>Logs de vérification</h2>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className="filter-select">
          <option value="all">Tous</option>
          <option value="success">Succès</option>
          <option value="failed">Échecs</option>
        </select>
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>Statut</th>
              <th>Discord ID</th>
              <th>Adresse IP</th>
              <th>Raison</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {filteredLogs.map((log) => (
              <tr key={log.id}>
                <td>
                  {log.success ? (
                    <span className="badge badge-success">Succès</span>
                  ) : (
                    <span className="badge badge-danger">Échec</span>
                  )}
                </td>
                <td><code>{log.discordId}</code></td>
                <td><code>{log.ipAddress}</code></td>
                <td>{log.reason || '-'}</td>
                <td>{new Date(log.createdAt).toLocaleString('fr-FR')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredLogs.length === 0 && <p className="empty-message">Aucun log trouvé</p>}
      </div>
    </div>
  )
}

export default VerificationLogs
