import { useState, useEffect } from 'react'
import './UserManagement.css'

interface User {
  id: string
  discordId: string
  ipAddress: string
  guildId: string
  roleId: string
  verifiedAt: string
}

function UserManagement() {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')

  useEffect(() => {
    fetchUsers()
  }, [])

  const fetchUsers = async () => {
    try {
      const response = await fetch('/api/admin/users', { credentials: 'include' })
      if (response.ok) {
        const data = await response.json()
        setUsers(data.users)
      }
    } catch (error) {
      console.error('Failed to fetch users:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (userId: string) => {
    if (!confirm('Êtes-vous sûr de vouloir supprimer cet utilisateur?')) return

    try {
      const response = await fetch(`/api/admin/users/${userId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (response.ok) {
        fetchUsers()
      }
    } catch (error) {
      console.error('Failed to delete user:', error)
    }
  }

  const filteredUsers = users.filter((user) =>
    user.discordId.includes(searchTerm) || user.ipAddress.includes(searchTerm)
  )

  if (loading) return <div className="loading">Chargement des utilisateurs...</div>

  return (
    <div className="user-management">
      <div className="section-header">
        <h2>Gestion des utilisateurs</h2>
        <input
          type="text"
          placeholder="Rechercher par Discord ID ou IP..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="search-input"
        />
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>Discord ID</th>
              <th>Adresse IP</th>
              <th>Vérifié le</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredUsers.map((user) => (
              <tr key={user.id}>
                <td><code>{user.discordId}</code></td>
                <td><code>{user.ipAddress}</code></td>
                <td>{new Date(user.verifiedAt).toLocaleString('fr-FR')}</td>
                <td>
                  <button onClick={() => handleDelete(user.id)} className="btn btn-danger btn-sm">
                    Supprimer
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredUsers.length === 0 && (
          <p className="empty-message">Aucun utilisateur trouvé</p>
        )}
      </div>
    </div>
  )
}

export default UserManagement
