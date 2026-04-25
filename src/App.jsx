import { useState, useCallback } from 'react'
import TopBar from './components/TopBar'
import Sidebar from './components/Sidebar'
import ThreatMap from './components/Map'
import IncidentDetail from './components/IncidentDetail'
import './styles/App.css'

export default function App() {
  const [selectedIncident, setSelectedIncident] = useState(null)

  const handleSelectIncident = useCallback((incident) => {
    setSelectedIncident(prev =>
      prev && prev.id === incident.id ? null : incident
    )
  }, [])

  const handleClose = useCallback(() => {
    setSelectedIncident(null)
  }, [])

  return (
    <div className="app">
      {/* Full-screen map sits behind everything */}
      <ThreatMap
        selectedId={selectedIncident?.id ?? null}
        onSelectIncident={handleSelectIncident}
      />

      {/* UI overlay */}
      <div className="app-layout">
        <TopBar />
        <div className="app-content">
          <Sidebar
            selectedId={selectedIncident?.id ?? null}
            onSelect={handleSelectIncident}
          />
          {/* Spacer so map is visible */}
          <div style={{ flex: 1 }} />
        </div>
      </div>

      {/* Incident detail panel */}
      {selectedIncident && (
        <IncidentDetail
          incident={selectedIncident}
          onClose={handleClose}
        />
      )}
    </div>
  )
}
