import { useState, useEffect } from 'react'
import './ListManager.css'

interface WhitelistEntry {
  id: string
  ipAddress?: string
  discordId?: string
  guildId: string
  reason?: string
  addedBy: string
  createdAt: string
}

function WhitelistManager() {
  const [entries, setEntries] = useState<WhitelistEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [formData, setFormData] = useState({ type: 'ip', value: '', reason: '' })

  useEffect(() => {
    fetchEntries()
  }, [])

  const fetchEntries = async () => {
    try {
      const response = await fetch('/api/admin/whitelist', { credentials: 'include' })
      if (response.ok) {
        const data = await response.json()
        setEntries(data.entries)
      }
    } catch (error) {
      console.error('Failed to fetch whitelist:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const payload = formData.type === 'ip'
        ? { ipAddress: formData.value, reason: formData.reason }
        : { discordId: formData.value, reason: formData.reason }

      const response = await fetch('/api/admin/whitelist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      })

      if (response.ok) {
        setFormData({ type: 'ip', value: '', reason: '' })
        setShowAddForm(false)
        fetchEntries()
      }
    } catch (error) {
      console.error('Failed to add entry:', error)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Supprimer cette entrée?')) return

    try {
      const response = await fetch(`/api/admin/whitelist/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (response.ok) fetchEntries()
    } catch (error) {
      console.error('Failed to delete entry:', error)
    }
  }

  if (loading) return <div className="loading">Chargement...</div>

  return (
    <div className="list-manager">
      <div className="section-header">
        <h2>Whitelist</h2>
        <button onClick={() => setShowAddForm(!showAddForm)} className="btn btn-success">
          + Ajouter
        </button>
      </div>

      {showAddForm && (
        <form onSubmit={handleSubmit} className="add-form">
          <select value={formData.type} onChange={(e) => setFormData({ ...formData, type: e.target.value })}>
            <option value="ip">Adresse IP</option>
            <option value="discord">Discord ID</option>
          </select>
          <input
            type="text"
            placeholder={formData.type === 'ip' ? 'Adresse IP' : 'Discord ID'}
            value={formData.value}
            onChange={(e) => setFormData({ ...formData, value: e.target.value })}
            required
          />
          <input
            type="text"
            placeholder="Raison (optionnel)"
            value={formData.reason}
            onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
          />
          <div className="form-actions">
            <button type="submit" className="btn btn-success">Ajouter</button>
            <button type="button" onClick={() => setShowAddForm(false)} className="btn btn-secondary">Annuler</button>
          </div>
        </form>
      )}

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Valeur</th>
              <th>Raison</th>
              <th>Ajouté le</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>
                  <span className="badge badge-info">
                    {entry.ipAddress ? 'IP' : 'Discord'}
                  </span>
                </td>
                <td><code>{entry.ipAddress || entry.discordId}</code></td>
                <td>{entry.reason || '-'}</td>
                <td>{new Date(entry.createdAt).toLocaleString('fr-FR')}</td>
                <td>
                  <button onClick={() => handleDelete(entry.id)} className="btn btn-danger btn-sm">
                    Supprimer
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length === 0 && <p className="empty-message">Aucune entrée</p>}
      </div>
    </div>
  )
}

export default WhitelistManager
