import { useState, useCallback } from 'react'
import TopBar from './components/TopBar'
import Sidebar from './components/Sidebar'
import ThreatMap from './components/Map'
import IncidentDetail from './components/IncidentDetail'
import { useIncidents } from './hooks/useIncidents'
import './styles/App.css'

export default function App() {
  const [selectedId, setSelectedId] = useState(null)
  const incidents = useIncidents()
  const selectedIncident = incidents.find(i => i.id === selectedId) || null

  const handleSelect = useCallback((incident) => {
    setSelectedId(prev => (prev === incident.id ? null : incident.id))
  }, [])

  const handleClose = useCallback(() => setSelectedId(null), [])

  return (
    <div className="app">
      <ThreatMap
        incidents={incidents}
        selectedId={selectedId}
        onSelectIncident={handleSelect}
      />

      <div className="app-layout">
        <TopBar />
        <div className="app-content">
          <Sidebar
            incidents={incidents}
            selectedId={selectedId}
            onSelect={handleSelect}
          />
          <div style={{ flex: 1 }} />
        </div>
      </div>

      {selectedIncident && (
        <IncidentDetail
          incident={selectedIncident}
          onClose={handleClose}
        />
      )}
    </div>
  )
}
